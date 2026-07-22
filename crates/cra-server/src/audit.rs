//! Журнал аудита (кто, что, когда).
//!
//! Каждое важное для безопасности действие (вход, запрос расчёта) пишем одной
//! строкой в stderr. Под systemd это попадает в журнал. Формат — стабильные
//! пары key=value, so it can be forwarded to a SIEM. Аттестованные системы
//! требуют такой журнал.

use std::io::Write;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Замок, чтобы строки от разных потоков не смешивались.
static LOCK: Mutex<()> = Mutex::new(());

pub struct AuditRecord<'a> {
    pub event: &'a str,
    pub peer: &'a str,
    pub principal: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub status: u16,
    pub detail: &'a str,
}

pub fn log(rec: &AuditRecord) {
    let ts = unix_millis();
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut err = std::io::stderr().lock();
    let _ = writeln!(
        err,
        "audit ts={} event={} peer={} principal={} method={} path={} status={} detail={}",
        ts,
        rec.event,
        rec.peer,
        quote(rec.principal),
        rec.method,
        quote(rec.path),
        rec.status,
        quote(rec.detail),
    );
}

/// Взять значение в кавычки и экранировать кавычки/переводы строк. So one field
/// can never break the log line (защита от подделки строк журнала).
fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if c.is_control() => out.push('.'),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_escapes_injection() {
        assert_eq!(quote("ok"), "\"ok\"");
        assert_eq!(quote("a\nb"), "\"a\\nb\"");
        assert_eq!(quote("x\"y"), "\"x\\\"y\"");
    }
}
