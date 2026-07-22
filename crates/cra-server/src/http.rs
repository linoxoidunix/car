//! Простой разбор HTTP/1.1 запроса и запись ответа поверх std::net.
//!
//! Специально маленький и без зависимостей. Внутреннему сервису расчёта не
//! нужен async-рантайм; для сертификации важнее малый и проверяемый объём
//! кода, чем скорость. TLS здесь нет by design — ГОСТ-TLS ставит впереди
//! сертифицированный прокси (см. deploy/).

use std::collections::HashMap;
use std::io::{self, BufReader, Read, Write};
use std::net::TcpStream;

/// Предел размера тела запроса (защита памяти от слишком больших запросов).
pub const MAX_BODY: usize = 64 * 1024 * 1024;
/// Предел размера всех заголовков вместе.
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_HEADERS: usize = 100;

/// Разобранный HTTP-запрос.
#[derive(Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    /// Raw query string (after `?`); parsed but not used by current routes.
    #[allow(dead_code)]
    pub query: String,
    /// Header names are lowercased for case-insensitive lookup.
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(|s| s.as_str())
    }
}

/// Результат чтения запроса: разобранный запрос, чистый конец (клиент закрыл
/// связь, ничего не прислав) или ошибка протокола с кодом ответа.
pub enum ReadOutcome {
    Request(Box<Request>),
    Eof,
    BadRequest(u16, &'static str),
}

pub fn read_request(reader: &mut BufReader<&TcpStream>) -> io::Result<ReadOutcome> {
    // Request line.
    let mut line = String::new();
    let n = read_line_limited(reader, &mut line, 8 * 1024)?;
    if n == 0 {
        return Ok(ReadOutcome::Eof);
    }
    let line = line.trim_end();
    let mut parts = line.split_whitespace();
    let (method, target, version) = match (parts.next(), parts.next(), parts.next()) {
        (Some(m), Some(t), Some(v)) => (m.to_string(), t.to_string(), v),
        _ => return Ok(ReadOutcome::BadRequest(400, "malformed request line")),
    };
    if !version.starts_with("HTTP/1.") {
        return Ok(ReadOutcome::BadRequest(505, "unsupported HTTP version"));
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };

    // Headers.
    let mut headers: HashMap<String, String> = HashMap::new();
    let mut header_bytes = 0usize;
    loop {
        let mut hline = String::new();
        let hn = read_line_limited(reader, &mut hline, 16 * 1024)?;
        if hn == 0 {
            return Ok(ReadOutcome::BadRequest(400, "unexpected EOF in headers"));
        }
        let hline = hline.trim_end_matches(['\r', '\n']);
        if hline.is_empty() {
            break;
        }
        header_bytes += hn;
        if header_bytes > MAX_HEADER_BYTES || headers.len() >= MAX_HEADERS {
            return Ok(ReadOutcome::BadRequest(431, "header block too large"));
        }
        let Some((name, value)) = hline.split_once(':') else {
            return Ok(ReadOutcome::BadRequest(400, "malformed header"));
        };
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }

    // Body (Content-Length only; chunked is not accepted).
    if headers
        .get("transfer-encoding")
        .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"))
    {
        return Ok(ReadOutcome::BadRequest(411, "chunked transfer-encoding not supported"));
    }
    let body = match headers.get("content-length") {
        Some(v) => {
            let len: usize = match v.parse() {
                Ok(l) => l,
                Err(_) => return Ok(ReadOutcome::BadRequest(400, "invalid content-length")),
            };
            if len > MAX_BODY {
                return Ok(ReadOutcome::BadRequest(413, "payload too large"));
            }
            let mut buf = vec![0u8; len];
            reader.read_exact(&mut buf)?;
            buf
        }
        None => Vec::new(),
    };

    Ok(ReadOutcome::Request(Box::new(Request {
        method,
        path,
        query,
        headers,
        body,
    })))
}

/// Read one line including the terminating `\n`, but never more than `max`
/// bytes (guards against unbounded lines). Returns bytes read.
fn read_line_limited(
    reader: &mut BufReader<&TcpStream>,
    out: &mut String,
    max: usize,
) -> io::Result<usize> {
    let mut buf = Vec::new();
    let mut total = 0usize;
    loop {
        let mut byte = [0u8; 1];
        let got = reader.read(&mut byte)?;
        if got == 0 {
            break;
        }
        total += 1;
        buf.push(byte[0]);
        if byte[0] == b'\n' || total >= max {
            break;
        }
    }
    // Lossless-ish: request lines/headers must be valid UTF-8 for our use.
    out.push_str(&String::from_utf8_lossy(&buf));
    Ok(total)
}

pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    pub extra_headers: Vec<(String, String)>,
}

impl Response {
    pub fn new(status: u16, content_type: &'static str, body: Vec<u8>) -> Self {
        Response { status, content_type, body, extra_headers: Vec::new() }
    }

    pub fn json(status: u16, body: Vec<u8>) -> Self {
        Response::new(status, "application/json; charset=utf-8", body)
    }

    pub fn text(status: u16, msg: &str) -> Self {
        Response::new(status, "text/plain; charset=utf-8", msg.as_bytes().to_vec())
    }

    /// A JSON error envelope: {"error": "..."}.
    pub fn error(status: u16, msg: &str) -> Self {
        let body = serde_json::json!({ "error": msg }).to_string().into_bytes();
        Response::json(status, body)
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.extra_headers.push((name.to_string(), value.to_string()));
        self
    }

    pub fn write(&self, stream: &mut TcpStream, keep_alive: bool) -> io::Result<()> {
        let reason = reason_phrase(self.status);
        let mut head = format!(
            "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: {}\r\n",
            self.status,
            reason,
            self.content_type,
            self.body.len(),
            if keep_alive { "keep-alive" } else { "close" },
        );
        // Security-relevant default headers.
        head.push_str("X-Content-Type-Options: nosniff\r\n");
        head.push_str("Referrer-Policy: no-referrer\r\n");
        for (n, v) in &self.extra_headers {
            head.push_str(&format!("{n}: {v}\r\n"));
        }
        head.push_str("\r\n");
        stream.write_all(head.as_bytes())?;
        stream.write_all(&self.body)?;
        stream.flush()
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Payload Too Large",
        414 => "URI Too Long",
        422 => "Unprocessable Entity",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        505 => "HTTP Version Not Supported",
        _ => "OK",
    }
}
