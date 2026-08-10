//! Минимальный HTTP-сервис поверх движка CRA.
//!
//! Первая рабочая версия: один поток, один запрос на связь. Этого уже
//! достаточно, чтобы запустить службу и посчитать модель:
//!
//! ```text
//! cra-server &
//! curl -s -X POST localhost:8080/api/analyze \
//!      -d @crates/cra-cli/examples/fault_tree.json
//! ```
//!
//! Адрес задаётся переменной CRA_ADDR (по умолчанию 127.0.0.1:8080 — только
//! петля, наружу служба не смотрит).
//!
//! Дальше сервис обрастёт настройками, пулом рабочих потоков,
//! аутентификацией, журналом аудита и встроенным веб-интерфейсом — каждый
//! раз отдельным шагом. Всё, что здесь лежит в одном файле, постепенно
//! разъедется по модулям.
//!
//! TLS нет и не будет: впереди ставится сертифицированный ГОСТ-TLS прокси.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};

/// Умолчание — только петля: без явного указания служба недоступна из сети.
const DEFAULT_ADDR: &str = "127.0.0.1:8080";
/// Предел размера тела запроса — защита памяти от слишком больших моделей.
const MAX_BODY: usize = 8 * 1024 * 1024;

fn main() {
    let addr = std::env::var("CRA_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.to_string());
    let listener = match TcpListener::bind(&addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("не удалось занять {addr}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("cra-server слушает http://{addr}");
    eprintln!("  GET  /healthz      проверка живости");
    eprintln!("  POST /api/analyze  расчёт модели (JSON на входе и выходе)");

    // Связи обрабатываем по очереди, в одном потоке. Для первой версии
    // этого хватает; пул потоков появится позже.
    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => handle(stream),
            Err(e) => eprintln!("ошибка приёма связи: {e}"),
        }
    }
}

/// Обработать одну связь: прочитать запрос, ответить, закрыть.
fn handle(mut stream: TcpStream) {
    // Читаем в отдельной области видимости: reader одалживает stream, а
    // ответ пишется уже в него самого.
    let parsed = {
        let mut reader = BufReader::new(&stream);
        read_request(&mut reader)
    };
    let Some((method, path, body)) = parsed else {
        return;
    };

    let (status, ctype, out) = match (method.as_str(), path.as_str()) {
        ("GET", "/healthz") => (200, "text/plain; charset=utf-8", b"ok".to_vec()),
        ("POST", "/api/analyze") => analyze(&body),
        ("GET", "/") => (
            200,
            "text/plain; charset=utf-8",
            concat!(
                "CRA — расчёт надёжности схем (деревья отказов, СФЦ).\n\n",
                "POST /api/analyze   модель в JSON -> отчёт в JSON\n",
                "GET  /healthz       проверка живости\n\n",
                "Веб-интерфейс появится позже.\n"
            )
            .as_bytes()
            .to_vec(),
        ),
        _ => (404, "text/plain; charset=utf-8", b"not found".to_vec()),
    };
    respond(&mut stream, status, ctype, &out);
}

/// Разобрать запрос настолько, насколько нужно: метод, путь и тело.
/// Из заголовков интересует только Content-Length.
fn read_request(reader: &mut BufReader<&TcpStream>) -> Option<(String, String, Vec<u8>)> {
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None; // клиент закрыл связь, ничего не прислав
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();

    let mut len = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break; // пустая строка — конец заголовков
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                len = value.trim().parse().ok()?;
            }
        }
    }
    if len > MAX_BODY {
        return None;
    }
    let mut body = vec![0u8; len];
    if len > 0 {
        reader.read_exact(&mut body).ok()?;
    }
    Some((method, path, body))
}

/// Расчёт: JSON на входе, JSON на выходе.
///
/// Три класса ошибок различаются кодом ответа: 400 — текст не разобрался
/// как JSON, 422 — JSON верен, но модель отвергнута движком (цикл в схеме,
/// отрицательная интенсивность), 500 — наша собственная беда.
fn analyze(body: &[u8]) -> (u16, &'static str, Vec<u8>) {
    let req: cra::Request = match serde_json::from_slice(body) {
        Ok(r) => r,
        Err(e) => {
            return (
                400,
                "text/plain; charset=utf-8",
                format!("некорректный JSON запроса: {e}").into_bytes(),
            )
        }
    };
    match cra::analyze_request(&req) {
        Ok(resp) => match serde_json::to_vec(&resp) {
            Ok(bytes) => (200, "application/json; charset=utf-8", bytes),
            Err(e) => (
                500,
                "text/plain; charset=utf-8",
                format!("не удалось собрать ответ: {e}").into_bytes(),
            ),
        },
        Err(e) => (422, "text/plain; charset=utf-8", e.into_bytes()),
    }
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        422 => "Unprocessable Entity",
        _ => "Internal Server Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}
