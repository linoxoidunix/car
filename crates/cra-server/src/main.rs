//! HTTP-сервис CRA: тонкая обёртка над движком cra-core. Отдаёт встроенный
//! веб-интерфейс и JSON-API для расчёта.
//!
//! Настройки — через переменные окружения (см. `config.rs`). TLS здесь нет by
//! design: ставьте впереди сертифицированный ГОСТ-TLS прокси.

mod assets;
mod audit;
mod auth;
mod config;
mod handlers;
mod http;
mod server;

use config::Config;

fn main() {
    if std::env::args().any(|a| a == "-h" || a == "--help") {
        print_help();
        return;
    }
    let cfg = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("configuration error: {e}");
            std::process::exit(2);
        }
    };
    if let Err(e) = server::serve(cfg) {
        eprintln!("fatal: {e}");
        std::process::exit(1);
    }
}

fn print_help() {
    eprint!(
        "cra-server — HTTP frontend for the CRA reliability engine\n\
         \n\
         Configuration (environment variables):\n\
         \n\
         CRA_ADDR            bind address           (default 127.0.0.1:8080)\n\
         CRA_WORKERS         worker threads         (default = CPU count)\n\
         CRA_MAX_CONN        max concurrent conns   (default 256)\n\
         CRA_TIMEOUT_SECS    per-request timeout    (default 120, 0 = off)\n\
         CRA_AUTH            none | token | proxy   (default none)\n\
         CRA_TOKEN           bearer token           (required if AUTH=token)\n\
         CRA_PROXY_HEADER    identity header        (default X-Remote-User)\n\
         CRA_TRUSTED_PROXIES trusted proxy IPs (default 127.0.0.1,::1)\n\
         \n\
         Endpoints:\n\
         GET  /                    web frontend\n\
         POST /api/analyze         analyze a model (JSON in, JSON out)\n\
         GET  /api/examples/<name> built-in example request\n\
         GET  /healthz             liveness probe\n\
         \n\
         Deploy behind a certified ГОСТ-TLS proxy; do not expose plain HTTP\n\
         outside a trusted network segment.\n"
    );
}
