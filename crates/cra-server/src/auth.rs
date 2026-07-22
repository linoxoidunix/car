//! Способы аутентификации (кто ты такой).
//!
//! Сервис сам НЕ хранит пароли. Три режима покрывают реальные схемы на Астре:
//!
//! * `None`  — доверенный сегмент сети, без проверки (адрес клиента всё равно
//!             пишем в журнал).
//! * `Token` — общий токен (Authorization: Bearer <t>); simplest gate for an
//!             internal tool.
//! * `Proxy` — личность подтверждает доверенный прокси спереди (тот же, что
//!             терминирует ГОСТ-TLS) через заголовок, напр. X-Remote-User.
//!             This is the ALD Pro / Kerberos SSO path: прокси делает вход по
//!             домену и передаёт нам имя пользователя.
//!
//! В режиме `Proxy` мы принимаем заголовок только от доверенных адресов —
//! so a direct client cannot fake the header.

use std::net::IpAddr;

use crate::http::Request;

#[derive(Debug, Clone)]
pub enum AuthMode {
    None,
    Token { token: String },
    Proxy { header: String, trusted: Vec<IpAddr> },
}

pub enum AuthResult {
    /// Authenticated principal name (for the audit log).
    Ok(String),
    /// Rejected, with a reason for the audit log.
    Denied(&'static str),
}

impl AuthMode {
    /// Проверить запрос. Возвращает имя пользователя (для журнала) или отказ.
    pub fn authenticate(&self, req: &Request, peer: IpAddr) -> AuthResult {
        match self {
            AuthMode::None => AuthResult::Ok("anonymous".to_string()),
            AuthMode::Token { token } => match req.header("authorization") {
                Some(h) => {
                    let presented = h.strip_prefix("Bearer ").unwrap_or(h).trim();
                    if constant_time_eq(presented.as_bytes(), token.as_bytes()) {
                        AuthResult::Ok("token".to_string())
                    } else {
                        AuthResult::Denied("invalid token")
                    }
                }
                None => AuthResult::Denied("missing authorization header"),
            },
            AuthMode::Proxy { header, trusted } => {
                if !trusted.contains(&peer) {
                    return AuthResult::Denied("proxy header from untrusted peer");
                }
                match req.header(&header.to_ascii_lowercase()) {
                    Some(user) if !user.trim().is_empty() => {
                        AuthResult::Ok(sanitize_principal(user))
                    }
                    _ => AuthResult::Denied("missing or empty proxy identity header"),
                }
            }
        }
    }
}

/// Сравнение за постоянное время (constant-time). Так по времени работы нельзя
/// угадать префикс токена. Разницу длин проверяем сразу (длина не секрет).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Keep only characters safe for an audit-log principal field.
fn sanitize_principal(raw: &str) -> String {
    raw.trim()
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '@' | '.' | '-' | '_' | '\\' | '/'))
        .take(128)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_basic() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secrdut"));
        assert!(!constant_time_eq(b"secret", b"secre"));
    }

    #[test]
    fn sanitize_strips_control_chars() {
        assert_eq!(sanitize_principal("  user@astra\n\t "), "user@astra");
        assert_eq!(sanitize_principal("EVIL\r\nSET-COOKIE"), "EVILSET-COOKIE");
        assert_eq!(sanitize_principal("DOMAIN\\ivanov"), "DOMAIN\\ivanov");
    }
}
