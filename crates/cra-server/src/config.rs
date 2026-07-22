//! Настройки сервера из переменных окружения (удобно задавать в systemd-юните).
//! У всех настроек есть безопасные значения по умолчанию.

use std::net::IpAddr;

use crate::auth::AuthMode;

#[derive(Debug, Clone)]
pub struct Config {
    pub addr: String,
    pub workers: usize,
    /// Max concurrent connections (backpressure; excess is rejected with 503).
    pub max_connections: usize,
    /// Per-request wall-clock read/compute guard, seconds (0 = disabled).
    pub request_timeout_secs: u64,
    pub auth: AuthMode,
}

impl Config {
    pub fn from_env() -> Result<Config, String> {
        let addr = env_or("CRA_ADDR", "127.0.0.1:8080");
        let workers = parse_env("CRA_WORKERS", default_workers())?;
        let max_connections = parse_env("CRA_MAX_CONN", 256)?;
        let request_timeout_secs = parse_env("CRA_TIMEOUT_SECS", 120)?;

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

        if workers == 0 {
            return Err("CRA_WORKERS must be >= 1".into());
        }
        Ok(Config { addr, workers, max_connections, request_timeout_secs, auth })
    }

    pub fn auth_summary(&self) -> &'static str {
        match self.auth {
            AuthMode::None => "none",
            AuthMode::Token { .. } => "token",
            AuthMode::Proxy { .. } => "proxy-header",
        }
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn parse_env<T: std::str::FromStr>(key: &str, default: T) -> Result<T, String> {
    match std::env::var(key) {
        Ok(v) => v.parse().map_err(|_| format!("invalid value for {key}: '{v}'")),
        Err(_) => Ok(default),
    }
}

fn parse_trusted(s: &str) -> Result<Vec<IpAddr>, String> {
    s.split(',')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| p.parse::<IpAddr>().map_err(|_| format!("invalid trusted proxy IP '{p}'")))
        .collect()
}

fn default_workers() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4)
}
