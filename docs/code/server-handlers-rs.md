# 15. `crates/cra-server/src/handlers.rs` — маршрутизация и обработчики

**Размер:** 113 строк. **Задача:** решить, что делать с разобранным запросом,
проверить право доступа, вызвать движок и записать событие в журнал.

## Какую задачу решает

`http.rs` даёт структуру `Request`. `server.rs` доставил её в рабочий поток.
Осталось соотнести метод и путь с действием — и сделать это так, чтобы
защищённый ресурс невозможно было случайно оставить открытым.

## Порядок: сначала доступ, потом маршрут

```rust
pub fn handle(req: &Request, peer: IpAddr, auth: &AuthMode) -> Response {
    let principal = if is_protected(&req.path) {
        match auth.authenticate(req, peer) {
            AuthResult::Ok(p) => p,
            AuthResult::Denied(reason) => {
                audit::log(&AuditRecord { event: "auth_denied", …, status: 401, detail: reason });
                …
                return Response::error(401, reason);
            }
        }
    } else {
        "anonymous".to_string()
    };

    let resp = route(req, &principal);
    …
}
```

Аутентификация выполняется **до** маршрутизации, в одном месте. Это
принципиально: если бы каждый обработчик проверял доступ сам, добавление
нового endpoint'а могло бы тихо оставить его без защиты. Здесь новый маршрут
автоматически защищён, если его путь подпадает под правило.

## Правило защиты

```rust
fn is_protected(path: &str) -> bool {
    path.starts_with("/api/")
}
```

Одна строка, и её последствия:

| Путь | Защищён? | Почему |
|---|---|---|
| `/`, `/app.js`, `/style.css` | нет | страница должна загрузиться, чтобы пользователю было куда вводить учётные данные |
| `/healthz` | нет | проверку живости делают systemd и мониторинг, у них нет токена |
| `/api/analyze` | **да** | здесь тратятся ресурсы и обрабатываются данные |
| `/api/examples/...` | **да** | под общим правилом |

Правило по префиксу, а не список исключений. Список пришлось бы дополнять при
каждом новом маршруте, и однажды это забыли бы сделать.

Статические файлы открыты сознательно: в них нет ничего секретного — это
редактор схем, а сами схемы через них не проходят.

## Таблица маршрутов

```rust
fn route(req: &Request, principal: &str) -> Response {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/healthz") => Response::text(200, "ok"),
        ("POST", "/api/analyze") => analyze(req, principal),
        ("GET", p) if p.starts_with("/api/examples/") => { … }
        ("GET", p) | ("HEAD", p) => match assets::find(p) {
            Some(a) => Response::new(200, a.content_type, a.bytes.to_vec()),
            None => Response::error(404, "not found"),
        },
        (_, "/api/analyze") => Response::error(405, "method not allowed"),
        _ => Response::error(405, "method not allowed"),
    }
}
```

Сопоставление кортежа `(метод, путь)` — маршрутизатор целиком, без библиотек и
без регулярных выражений. Порядок ветвей значим: специальные пути идут раньше
общего обработчика статики.

Ветка `(_, "/api/analyze") => 405` даёт правильный ответ на `GET /api/analyze`:
не «не найдено», а «метод не разрешён». Мелочь, но именно она отличает
корректную реализацию HTTP от приблизительной.

`GET` и `HEAD` обрабатываются одинаково — `HEAD` должен вести себя как `GET`,
но без тела; тело отбрасывается уровнем ниже.

## `/api/analyze` — главный обработчик

```rust
fn analyze(req: &Request, principal: &str) -> Response {
    if req.body.len() > MAX_BODY {
        return Response::error(413, "payload too large");
    }
    let parsed: Result<AnalysisRequest, _> = serde_json::from_slice(&req.body);
    let request = match parsed {
        Ok(r) => r,
        Err(e) => return Response::error(400, &format!("invalid request JSON: {e}")),
    };
    match cra::analyze_request(&request) {
        Ok(resp) => match serde_json::to_vec(&resp) {
            Ok(body) => Response::json(200, body),
            Err(e) => { audit::log(…500…); Response::error(500, "failed to serialize response") }
        },
        Err(e) => Response::error(422, &e),
    }
}
```

Обратите внимание на **три разных кода ошибки для трёх разных проблем**:

| Код | Когда | Кто виноват |
|---|---|---|
| **400** Bad Request | текст не является корректным JSON | клиент, синтаксис |
| **422** Unprocessable Entity | JSON корректен, но модель отвергнута движком (цикл, отрицательная λ, ссылка в никуда) | клиент, смысл |
| **500** Internal Server Error | не удалось сериализовать ответ | сервер |

Различие 400 и 422 — не педантизм. Оно говорит пользователю, где искать: в
кавычках и запятых или в самой схеме. Веб-интерфейс показывает текст ошибки из
поля `error` в обоих случаях, и сообщения движка вида
`gate 'g1': 'atleast' requires field 'k'` попадают прямо на экран.

Ошибка 500 дополнительно пишется в журнал аудита с подробностями, а клиенту
отдаётся общая формулировка — внутренние детали наружу не уходят.

Расчёт выполняется **прямо в рабочем потоке**, синхронно. Отдельной очереди
задач нет. Ограничение параллелизма обеспечивается числом потоков
(`CRA_WORKERS`) и пределом связей (`CRA_MAX_CONN`), а от бесконечного расчёта
защищает таймаут сокета.

## Журналирование

```rust
let resp = route(req, &principal);

if is_protected(&req.path) {
    audit::log(&AuditRecord {
        event: "request", peer: &peer.to_string(), principal: &principal,
        method: &req.method, path: &req.path, status: resp.status, detail: "",
    });
}
```

Записываются все обращения к защищённым путям, **и успешные тоже**. Для
аттестованной системы это обязательно: журнал должен отвечать на вопрос «кто и
когда запускал расчёты», а не только «кому отказали».

Статика и `/healthz` не логируются — иначе проверки живости раз в несколько
секунд утопили бы журнал в шуме и сделали бы его бесполезным.

## Заголовок `WWW-Authenticate`

```rust
let www = matches!(auth, AuthMode::Token { .. });
let mut resp = Response::error(401, reason);
if www {
    resp = resp.with_header("WWW-Authenticate", "Bearer");
}
```

Заголовок добавляется только в режиме токена. По стандарту ответ 401 должен
сообщать, какой способ аутентификации ожидается; в режиме `proxy` предлагать
клиенту аутентифицироваться бессмысленно — за него это делает прокси, и
намекать на другое поведение было бы вводящим в заблуждение.
