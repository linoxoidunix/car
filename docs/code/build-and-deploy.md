# 23. Файлы сборки и развёртывания

Здесь разобраны все оставшиеся файлы: четыре `Cargo.toml`, `.gitignore` и
каталог `deploy/`.

---

## `Cargo.toml` (корневой) — workspace

```toml
[workspace]
resolver = "2"
members = ["crates/cra-core", "crates/cra-cli", "crates/cra-server"]

[workspace.package]
version = "0.1.0"
edition = "2021"
rust-version = "1.70"
license = "Proprietary"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
cra-core = { path = "crates/cra-core" }

[profile.release]
lto = true
codegen-units = 1
```

**Workspace** объединяет три крейта: один `Cargo.lock` на всех, общий каталог
`target/`, одна команда `cargo build` собирает всё. Версии зависимостей заданы
один раз в `[workspace.dependencies]`, а крейты подключают их как
`serde = { workspace = true }` — разъехаться версии не могут.

`rust-version = "1.70"` — минимальная поддерживаемая версия компилятора. Она
здесь не формальность: в репозиториях Astra Linux компилятор может быть
заметно старше свежего. Указание MSRV даёт понятную ошибку сборки вместо
загадочного синтаксического сбоя.

Настройки выпускной сборки:

- `lto = true` — оптимизация на этапе компоновки: оптимизатор видит программу
  целиком и может встраивать функции через границы крейтов. Для расчётного
  кода это реальный выигрыш;
- `codegen-units = 1` — компиляция крейта одним блоком вместо параллельных
  частей. Сборка идёт медленнее, код получается быстрее.

Обе настройки уместны для программы, которую собирают редко, а выполняют
подолгу.

## `crates/cra-core/Cargo.toml`

```toml
[package]
name = "cra-core"
…
[lib]
name = "cra"
path = "src/lib.rs"

[dependencies]
serde = { workspace = true }
serde_json = { workspace = true }
```

Пакет `cra-core`, библиотека `cra` — отсюда `use cra::…` во всех файлах.

**Ровно две зависимости**, и ни одна из них не для математики, не для
параллелизма, не для веба. `serde` нужен только для JSON. Всё остальное —
BDD, uniformization, гамма-функции — написано в этих 2700 строках.

Причина в шапке README: `cargo vendor` для поставки в закрытый контур должен
оставаться небольшим и проверяемым. Каждая зависимость — это код, который надо
завендорить, обосновать и сопровождать.

## `crates/cra-cli/Cargo.toml`

```toml
[[bin]]
name = "cra"
path = "src/main.rs"

[dependencies]
cra-core = { workspace = true }
serde_json = { workspace = true }
```

Пакет `cra-cli`, исполняемый файл `cra`. Отсюда `cargo run --bin cra`.

## `crates/cra-server/Cargo.toml`

```toml
[[bin]]
name = "cra-server"
path = "src/main.rs"

[dependencies]
cra-core = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
```

HTTP-сервер **не имеет ни одной веб-зависимости**. Ни `hyper`, ни `axum`, ни
`tokio`. Всё построено на `std::net` — см.
[server-http-rs.md](server-http-rs.md).

## `Cargo.lock`

Файл не редактируется руками — его создаёт и обновляет сам `cargo`. Он
фиксирует **точные версии** всех зависимостей вместе с их контрольными
суммами.

Для библиотек `Cargo.lock` обычно не коммитят, а здесь — коммитят, и это
осознанно. Причина в поставке в закрытый контур: сборка на машине без интернета
должна дать ровно тот же результат, что и на машине разработчика. Без
зафиксированного `Cargo.lock` при `cargo vendor` могла бы подтянуться другая
минорная версия `serde`, и полученный бинарник отличался бы от проверенного.

## `README.md` (корневой)

Руководство **пользователя**, в отличие от этой папки, которая объясняет
**устройство**. В нём:

- назначение и раскладка workspace;
- метод расчёта в пяти пунктах (компиляция → декомпозиция → BDD → сборка →
  минимальные наборы);
- таблица семантики: что означает `top_probability`, сечения и пути для дерева
  отказов и для СФЦ;
- полное описание схемы входного JSON со всеми распределениями и видами
  элементов;
- описание обоих фронтендов и переменных окружения сервера;
- раздел о развёртывании на Астре: ГОСТ-TLS, аутентификация через прокси,
  журнал аудита, один уровень конфиденциальности на экземпляр.

Если нужно **написать модель** — читайте `README.md`. Если нужно **понять или
изменить код** — читайте эту папку.

## `.gitignore`

```
/target      # результат сборки Rust (большой, не коммитим)
*.swp
*~
.DS_Store
/out         # локальные патчи для переноса на тестовую машину
```

Каталог `/out` заслуживает пояснения: там лежат сгенерированные патчи для
переноса кода на тестовую машину. Они производны от истории git, поэтому в
истории им места нет.

---

# `deploy/` — развёртывание

## Модель безопасности целиком

```
        Тонкий клиент (Firefox)
                │
                │  ГОСТ-TLS
                ▼
    ┌───────────────────────────────┐
    │  nginx / Angie + КриптоПро    │   сертифицированное СКЗИ
    │  • терминирует ГОСТ-TLS       │
    │  • вход в домен (Kerberos)    │
    │  • ставит X-Remote-User       │
    └───────────────┬───────────────┘
                    │  обычный HTTP, только 127.0.0.1
                    ▼
    ┌───────────────────────────────┐
    │  cra-server                   │   обычное прикладное ПО
    │  • доверяет заголовку только  │
    │    с 127.0.0.1                │
    │  • пишет журнал аудита        │
    │  • песочница systemd          │
    └───────────────────────────────┘
```

Главная мысль: **приложение не заявляет себя средством защиты**. Шифрование
выполняет сертифицированное СКЗИ, вход в домен — прокси, а `cra-server`
остаётся обычной программой. Это принципиально снижает объём аттестации.

## `deploy/cra-server.service`

### Учётная запись и запуск

```ini
User=cra
Group=cra
ExecStart=/opt/cra/cra-server
Restart=on-failure
RestartSec=2
```

Выделенная непривилегированная учётная запись без оболочки входа. Запуск от
`root` для программы, слушающей сеть, недопустим.

### Настройки

```ini
Environment=CRA_ADDR=127.0.0.1:8080
Environment=CRA_WORKERS=8
Environment=CRA_MAX_CONN=256
Environment=CRA_TIMEOUT_SECS=120
Environment=CRA_AUTH=proxy
Environment=CRA_PROXY_HEADER=X-Remote-User
Environment=CRA_TRUSTED_PROXIES=127.0.0.1
```

`CRA_ADDR=127.0.0.1:8080` — **только петля**. Даже если брандмауэр настроен
неверно, снаружи к службе не подключиться. Единственный путь внутрь — через
прокси.

Про токен в комментарии сказано отдельно:

```ini
#   Environment=CRA_TOKEN=<put in a drop-in with mode 0600, not here>
```

Основной юнит читается всеми; секрет должен лежать в drop-in файле
`/etc/systemd/system/cra-server.service.d/token.conf` с правами 0600.

### Песочница systemd

```ini
NoNewPrivileges=true          # нельзя повысить права, даже через setuid
ProtectSystem=strict          # вся файловая система только для чтения
ProtectHome=true              # домашние каталоги невидимы
PrivateTmp=true               # свой /tmp
PrivateDevices=true           # нет доступа к устройствам
ProtectKernelTunables=true    # нельзя писать в /proc/sys
ProtectKernelModules=true     # нельзя загружать модули ядра
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6   # только IP-сокеты
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=true   # нет страниц одновременно записываемых и исполняемых
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
ReadWritePaths=               # ПУСТО: писать некуда вообще
```

Пустой `ReadWritePaths=` — прямое следствие решения из
[`assets.rs`](server-assets-rs.md): весь интерфейс внутри бинарника, журнал
идёт в stderr, файлов конфигурации нет. Программе действительно не нужно право
записи никуда.

`MemoryDenyWriteExecute=true` блокирует классический приём эксплуатации —
запись кода в память с последующим исполнением. Для программы на Rust без JIT
это ничего не ломает.

`SystemCallFilter=@system-service` разрешает только обычный для служб набор
системных вызовов; остальные возвращают `EPERM`, а не убивают процесс
(`SystemCallErrorNumber=EPERM`) — так поведение при срабатывании фильтра
понятнее в журнале.

Ограничения сформулированы так, что их можно проверить построчно при
аттестации, — это тоже часть замысла.

## `deploy/nginx-gost-tls.conf.example`

Файл честно предупреждает:

> This file shows the *shape* of the config; the exact ssl_certificate /
> engine directives depend on your certified СКЗИ.

Точные директивы зависят от конкретного СКЗИ (КриптоПро CSP, движок
OpenSSL-GOST, Angie), и пример не притворяется готовой конфигурацией.

### Самая важная часть

```nginx
location / {
    # Никогда не доверяй входящему заголовку личности: сначала очисти.
    proxy_set_header X-Remote-User "";
    # Затем поставь из аутентифицированного пользователя.
    proxy_set_header X-Remote-User $remote_user;
    …
}
```

Две строки, и они критичны. Без первой злоумышленник, приславший собственный
`X-Remote-User: admin`, мог бы его протащить. Порядок «сначала стереть, потом
поставить» гарантирует, что до `cra-server` доходит только то, что установил
прокси.

Это одна из трёх мер, описанных в [server-auth-rs.md](server-auth-rs.md):
слушать только петлю + доверять адресу + стирать заголовок на прокси. Все три
нужны одновременно.

### Прочие директивы

```nginx
proxy_read_timeout 180s;      # расчёт больших схем занимает время
client_max_body_size 64m;     # ограничение размера на границе — тоже
keepalive 16;                 # keep-alive держит прокси, не приложение
```

`client_max_body_size 64m` совпадает с `MAX_BODY` в
[`http.rs`](server-http-rs.md). Ограничение стоит на обеих границах — прокси
отсекает большие тела раньше, приложение всё равно проверяет само.

`proxy_read_timeout 180s` больше, чем `CRA_TIMEOUT_SECS=120`, поэтому первым
сработает таймаут приложения, а не прокси, — и клиент получит внятный ответ, а
не «502 Bad Gateway».

### Аутентификация в примере

```nginx
auth_basic           "CRA";
auth_basic_user_file /etc/cra/htpasswd;
```

С прямым указанием в комментарии:

> Minimal example: HTTP Basic. Prefer domain SSO in production.

Basic-аутентификация приведена лишь для того, чтобы пример был работоспособен и
понятен. В аттестованной системе на её месте должен быть Kerberos/SPNEGO через
ALD Pro или `auth_request` к внешней системе единого входа — тогда пользователи
не заводят ещё один пароль, а вход идёт по доменной учётной записи.

---

## Как собрать и запустить

```bash
# всё сразу
cargo build --release

# CLI
./target/release/cra crates/cra-cli/examples/fault_tree.json --pretty

# сервер (по умолчанию 127.0.0.1:8080, без аутентификации)
./target/release/cra-server

# справка по настройкам
./target/release/cra-server --help

# тесты
cargo test
```

Развёртывание на целевой машине:

```bash
useradd -r -s /usr/sbin/nologin cra
install -D -m 0755 target/release/cra-server /opt/cra/cra-server
install -D -m 0644 deploy/cra-server.service /etc/systemd/system/cra-server.service
systemctl daemon-reload
systemctl enable --now cra-server
journalctl -u cra-server -f        # журнал, включая записи аудита
```

Копируется **один файл** — весь интерфейс внутри него.
