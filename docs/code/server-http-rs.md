# 13. `crates/cra-server/src/http.rs` — HTTP/1.1, написанный вручную

**Размер:** 219 строк. **Задача:** прочитать HTTP-запрос из TCP-сокета и
записать HTTP-ответ, не привлекая ни одной внешней библиотеки.

## Какую задачу решает

Через сокет приходит поток байтов вида:

```
POST /api/analyze HTTP/1.1\r\n
Host: cra.internal\r\n
Content-Type: application/json\r\n
Content-Length: 137\r\n
\r\n
{"model": {...}}
```

Нужно превратить это в структуру с методом, путём, заголовками и телом — и
проделать обратное для ответа.

Обычно берут `hyper`, `axum` или `actix`. Здесь этого не делают, и причина
указана в шапке файла:

> Специально маленький и без зависимостей. Внутреннему сервису расчёта не
> нужен async-рантайм; для сертификации важнее малый и проверяемый объём кода,
> чем скорость.

`axum` тянет `hyper`, `tokio`, `tower` и ещё несколько десятков крейтов — сотни
тысяч строк. Здесь их 219, и их можно прочитать целиком. Для внутреннего
инструмента с несколькими десятками пользователей производительность
асинхронного стека попросту не нужна.

## Разбор запроса

### Ограничения — первое, что видно в файле

```rust
pub const MAX_BODY: usize = 64 * 1024 * 1024;    // 64 МиБ
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_HEADERS: usize = 100;
```

Написание своего разбора протокола означает, что защита от злонамеренного
ввода — целиком ваша забота. Три ограничения закрывают классические атаки:

- бесконечное тело → исчерпание памяти;
- бесконечный поток заголовков → исчерпание памяти;
- бесконечно длинная строка → то же самое.

### `ReadOutcome` — три исхода вместо двух

```rust
pub enum ReadOutcome {
    Request(Box<Request>),            // разобрали
    Eof,                              // клиент закрыл связь, ничего не прислав
    BadRequest(u16, &'static str),    // нарушение протокола + код ответа
}
```

Обычный `Result` здесь недостаточен, потому что исходов три, и они требуют
разного поведения. `Eof` — это не ошибка: браузеры и балансировщики регулярно
открывают связь и закрывают её (проверка доступности, предварительное
соединение). Логировать это как ошибку значило бы засорять журнал.

`Box<Request>` — потому что `Request` довольно велик (содержит `HashMap` и
`Vec`), и без бокса весь `enum` раздувался бы до размера самого крупного
варианта.

### Строка запроса

```rust
let (method, target, version) = match (parts.next(), parts.next(), parts.next()) {
    (Some(m), Some(t), Some(v)) => (m.to_string(), t.to_string(), v),
    _ => return Ok(ReadOutcome::BadRequest(400, "malformed request line")),
};
if !version.starts_with("HTTP/1.") {
    return Ok(ReadOutcome::BadRequest(505, "unsupported HTTP version"));
}
```

Разбор на три части через сопоставление кортежа. Проверка версии возвращает
именно 505 (Version Not Supported), а не общий 400 — клиент, попытавшийся
говорить по HTTP/2, получит осмысленный ответ.

### Заголовки

```rust
headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
```

Имена приводятся к нижнему регистру, потому что по стандарту они
регистронезависимы: `Content-Type`, `content-type` и `CONTENT-TYPE` — одно и
то же. Приведение при записи означает, что поиск потом всегда работает:

```rust
pub fn header(&self, name: &str) -> Option<&str> {
    self.headers.get(name).map(|s| s.as_str())
}
```

Этим пользуется [`auth.rs`](server-auth-rs.md), беря
`req.header(&header.to_ascii_lowercase())`.

### Тело

```rust
if headers.get("transfer-encoding")
          .is_some_and(|v| v.to_ascii_lowercase().contains("chunked")) {
    return Ok(ReadOutcome::BadRequest(411, "chunked transfer-encoding not supported"));
}
```

Chunked-кодирование **явно отвергается**, а не игнорируется. Это правильно с
точки зрения безопасности: расхождения в трактовке `Content-Length` и
`Transfer-Encoding` между прокси и сервером — источник целого класса атак
(request smuggling). Однозначный отказ такую неоднозначность исключает.

```rust
if len > MAX_BODY {
    return Ok(ReadOutcome::BadRequest(413, "payload too large"));
}
let mut buf = vec![0u8; len];
reader.read_exact(&mut buf)?;
```

Размер проверяется **до** выделения памяти. Клиент, заявивший
`Content-Length: 100000000000`, получит 413 немедленно, а не положит сервер
попыткой выделить 100 ГБ. Тест `oversized_body_rejected` в
[`http_smoke.rs`](server-tests-rs.md) проверяет именно это.

### `read_line_limited`

```rust
fn read_line_limited(reader, out, max) -> io::Result<usize> {
    loop {
        let mut byte = [0u8; 1];
        let got = reader.read(&mut byte)?;
        if got == 0 { break; }
        buf.push(byte[0]);
        if byte[0] == b'\n' || total >= max { break; }
    }
}
```

Чтение по одному байту выглядит медленным, но `reader` — это `BufReader`, у
которого внутри буфер на 8 КиБ, поэтому системный вызов происходит не на
каждый байт. Взамен получается точный контроль над границей: чтение
останавливается ровно на `\n` или на пределе `max`, ни байтом больше.

Стандартный `read_line` из `BufRead` для этого не годится — у него нет
ограничения длины, и одна бесконечная строка исчерпала бы память.

## Формирование ответа

```rust
pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    pub extra_headers: Vec<(String, String)>,
}
```

`&'static str` для типа содержимого означает, что тип может быть только
литералом, вкомпилированным в программу, — динамически сконструированный тип
невозможен, а с ним невозможен и целый класс инъекций в заголовки.

Конструкторы:

```rust
Response::json(200, body)       // application/json; charset=utf-8
Response::text(200, "ok")       // text/plain; charset=utf-8
Response::error(422, &msg)      // {"error": "..."} — единый конверт ошибки
```

`Response::error` даёт всем ошибкам одинаковую форму, поэтому веб-интерфейс
пишет просто `data.error || "HTTP " + r.status` и всегда получает
человекочитаемое сообщение.

### Заголовки безопасности по умолчанию

```rust
head.push_str("X-Content-Type-Options: nosniff\r\n");
head.push_str("Referrer-Policy: no-referrer\r\n");
```

Добавляются к **каждому** ответу, а не выборочно:

- `nosniff` запрещает браузеру угадывать тип содержимого; без него загруженный
  файл мог бы быть исполнен как скрипт;
- `no-referrer` не даёт внутреннему адресу утечь во внешние ссылки.

Умолчание по безопасности — это правильное умолчание: невозможно забыть
добавить заголовок в новом обработчике.

### `Content-Length` всегда точен

```rust
"…Content-Length: {}\r\nConnection: {}\r\n",
self.body.len(),
if keep_alive { "keep-alive" } else { "close" },
```

Длина берётся из фактического тела, а не задаётся отдельно. Рассогласование
длины и тела — ещё один источник request smuggling; здесь оно невозможно
конструктивно.

### `reason_phrase`

Таблица кодов и текстов. Обратите внимание на набор:

```
400 Bad Request              411 Length Required
401 Unauthorized             413 Payload Too Large
403 Forbidden                414 URI Too Long
404 Not Found                422 Unprocessable Entity
405 Method Not Allowed       431 Request Header Fields Too Large
                             500, 503, 505
```

Каждый код здесь действительно используется. Особенно уместен **422
Unprocessable Entity**: JSON синтаксически верен (иначе был бы 400), но модель
отвергнута движком (цикл в схеме, отрицательная λ). Это разные ошибки, и
клиент должен их различать — тесты `invalid_json_is_400` и
`engine_validation_error_is_422` это фиксируют.
