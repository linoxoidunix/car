# 12. `crates/cra-server/src/config.rs` — настройки из окружения

**Размер:** 80 строк. **Задача:** собрать `Config` из переменных окружения,
проверить его и отвергнуть неправильный.

## Почему переменные окружения, а не файл конфигурации

Служба рассчитана на запуск под systemd, а там настройки естественно
задаются строками `Environment=` прямо в юните
([deploy/cra-server.service](build-and-deploy.md)). Отсюда:

- один файл вместо двух (юнит + конфиг);
- нет своего формата конфигурации и его парсера;
- секреты кладутся в drop-in файл с правами 0600, отдельно от основного юнита;
- переопределение при отладке — просто `CRA_AUTH=none cargo run`.

## Структура

```rust
pub struct Config {
    pub addr: String,                 // что слушать
    pub workers: usize,               // сколько рабочих потоков
    pub max_connections: usize,       // предел одновременных связей
    pub request_timeout_secs: u64,    // таймаут на запрос (0 = выключен)
    pub auth: AuthMode,               // режим аутентификации
}
```

## Значения по умолчанию и их обоснование

```rust
let addr = env_or("CRA_ADDR", "127.0.0.1:8080");
let workers = parse_env("CRA_WORKERS", default_workers())?;
let max_connections = parse_env("CRA_MAX_CONN", 256)?;
let request_timeout_secs = parse_env("CRA_TIMEOUT_SECS", 120)?;
```

| Настройка | Умолчание | Почему именно так |
|---|---|---|
| `CRA_ADDR` | `127.0.0.1:8080` | **только петля.** Без явного указания служба недоступна из сети — безопасное умолчание. Чтобы выставить наружу, надо это осознанно написать. |
| `CRA_WORKERS` | число ядер | расчёт нагружает процессор, а не ждёт ввод-вывод; потоков по числу ядер достаточно |
| `CRA_MAX_CONN` | 256 | защита от исчерпания памяти: сверх этого числа возвращается 503 |
| `CRA_TIMEOUT_SECS` | 120 | зависший клиент не должен вечно занимать поток |

```rust
fn default_workers() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}
```

`available_parallelism()` учитывает ограничения cgroups — в контейнере с лимитом
в 2 ядра вернётся 2, а не число ядер хоста. Запасное значение 4 на случай, если
система не сообщила ничего.

## Режимы аутентификации

```rust
let auth = match env_or("CRA_AUTH", "none").as_str() {
    "none" => AuthMode::None,
    "token" => {
        let token = std::env::var("CRA_TOKEN")
            .map_err(|_| "CRA_AUTH=token requires CRA_TOKEN".to_string())?;
        if token.trim().len() < 8 {
            return Err("CRA_TOKEN must be at least 8 characters".into());
        }
        AuthMode::Token { token }
    }
    "proxy" => {
        let header = env_or("CRA_PROXY_HEADER", "X-Remote-User");
        let trusted = parse_trusted(&env_or("CRA_TRUSTED_PROXIES", "127.0.0.1,::1"))?;
        AuthMode::Proxy { header, trusted }
    }
    other => return Err(format!("unknown CRA_AUTH '{other}' (none|token|proxy)")),
};
```

Три момента, которые стоит заметить.

**1. Непротиворечивость гарантируется типом.** Токен физически не может
отсутствовать в режиме `Token`, потому что `AuthMode::Token { token: String }`
содержит его как поле. Состояние «режим токена включён, а токена нет»
непредставимо — не проверяется в рантайме, а не существует.

**2. Минимальная длина токена.** Восьмисимвольный минимум отсекает `test`,
`123`, `admin`. Это не полноценная политика паролей, но оно ловит самую частую
ошибку эксплуатации.

**3. Неизвестное значение — ошибка, а не умолчание.** Опечатка
`CRA_AUTH=tocken` роняет службу с внятным сообщением. Если бы неизвестное
значение молча трактовалось как `none`, опечатка в юните тихо отключила бы
аутентификацию — ровно тот класс ошибок, который приводит к утечкам.

## Вспомогательные функции

```rust
fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn parse_env<T: std::str::FromStr>(key: &str, default: T) -> Result<T, String> {
    match std::env::var(key) {
        Ok(v) => v.parse().map_err(|_| format!("invalid value for {key}: '{v}'")),
        Err(_) => Ok(default),
    }
}
```

`parse_env` — обобщённая: одна функция обслуживает и `usize`, и `u64`, потому
что тип выводится из типа умолчания. Существенно поведение: **отсутствие**
переменной — это умолчание, а **нечитаемое значение** — ошибка.
`CRA_WORKERS=abc` не превратится молча в «число ядер».

```rust
fn parse_trusted(s: &str) -> Result<Vec<IpAddr>, String> {
    s.split(',')
     .map(|p| p.trim())
     .filter(|p| !p.is_empty())
     .map(|p| p.parse::<IpAddr>().map_err(|_| format!("invalid trusted proxy IP '{p}'")))
     .collect()
}
```

Приятная особенность Rust: `collect()` в `Result<Vec<_>, _>` автоматически
превращает «коллекцию результатов» в «результат с коллекцией» — первая ошибка
прерывает разбор и возвращается наружу. Одна опечатка в списке доверенных
адресов не даст службе стартовать.

Разбор в `IpAddr` (а не хранение строк) означает, что сравнение в
[`auth.rs`](server-auth-rs.md) идёт по нормализованным адресам: `::1` и
`0:0:0:0:0:0:0:1` — один и тот же адрес, а не две разные строки.

## Финальная проверка

```rust
if workers == 0 {
    return Err("CRA_WORKERS must be >= 1".into());
}
```

Ноль потоков означал бы сервер, который принимает связи и никогда на них не
отвечает — самый неприятный вид отказа: внешне живой, фактически мёртвый.

## `auth_summary` — для стартового сообщения

```rust
pub fn auth_summary(&self) -> &'static str {
    match self.auth {
        AuthMode::None => "none",
        AuthMode::Token { .. } => "token",
        AuthMode::Proxy { .. } => "proxy-header",
    }
}
```

Используется в строке, которую `server.rs` печатает при запуске. Возвращается
именно краткая метка, а **не сам токен** — секрет не должен попасть в журнал.
