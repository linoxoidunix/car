//! Приём TCP-связей: пул рабочих потоков + ограничение числа связей.
//! Много потоков берут связи из общей очереди; если связей слишком много —
//! отвечаем 503 (сервер занят).

use std::io::BufReader;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::audit::{self, AuditRecord};
use crate::config::Config;
use crate::handlers;
use crate::http::{read_request, ReadOutcome, Response};

/// Запустить сервер: слушать адрес, раздавать связи рабочим потокам.
pub fn serve(cfg: Config) -> std::io::Result<()> {
    let listener = TcpListener::bind(&cfg.addr)?;
    let local = listener.local_addr()?;
    eprintln!(
        "cra-server listening on http://{local} · workers={} · auth={} · max_conn={}",
        cfg.workers,
        cfg.auth_summary(),
        cfg.max_connections,
    );
    eprintln!("note: serve behind a certified ГОСТ-TLS terminating proxy; do not expose plain HTTP outside a trusted segment");

    let cfg = Arc::new(cfg);
    let (tx, rx): (Sender<TcpStream>, Receiver<TcpStream>) = mpsc::channel();
    let rx = Arc::new(Mutex::new(rx));
    let inflight = Arc::new(AtomicUsize::new(0));

    // Пул рабочих потоков: каждый берёт связи из общей очереди (rx).
    let mut workers = Vec::with_capacity(cfg.workers);
    for _ in 0..cfg.workers {
        let rx = Arc::clone(&rx);
        let cfg = Arc::clone(&cfg);
        let inflight = Arc::clone(&inflight);
        workers.push(thread::spawn(move || loop {
            let stream = {
                let guard = rx.lock().unwrap_or_else(|e| e.into_inner());
                guard.recv()
            };
            match stream {
                Ok(stream) => {
                    handle_connection(stream, &cfg);
                    inflight.fetch_sub(1, Ordering::AcqRel);
                }
                Err(_) => break, // channel closed: shut down
            }
        }));
    }

    for incoming in listener.incoming() {
        match incoming {
            Ok(stream) => {
                let current = inflight.fetch_add(1, Ordering::AcqRel) + 1;
                if current > cfg.max_connections {
                    inflight.fetch_sub(1, Ordering::AcqRel);
                    reject_overloaded(stream);
                    continue;
                }
                if tx.send(stream).is_err() {
                    break;
                }
            }
            Err(e) => {
                eprintln!("accept error: {e}");
            }
        }
    }
    drop(tx);
    for w in workers {
        let _ = w.join();
    }
    Ok(())
}

fn reject_overloaded(mut stream: TcpStream) {
    let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
    audit::log(&AuditRecord {
        event: "rejected",
        peer: &peer,
        principal: "-",
        method: "-",
        path: "-",
        status: 503,
        detail: "connection limit reached",
    });
    let _ = Response::error(503, "server busy").write(&mut stream, false);
}

/// Обработать одну связь: прочитать запрос, ответить, закрыть.
fn handle_connection(stream: TcpStream, cfg: &Config) {
    let peer_ip = match stream.peer_addr() {
        Ok(a) => a.ip(),
        Err(_) => return,
    };
    if cfg.request_timeout_secs > 0 {
        let d = Some(Duration::from_secs(cfg.request_timeout_secs));
        let _ = stream.set_read_timeout(d);
        let _ = stream.set_write_timeout(d);
    }
    let _ = stream.set_nodelay(true);

    // Один запрос на связь (Connection: close). Так проще и надёжнее; для
    // внутреннего инструмента этого достаточно.
    let mut reader = BufReader::new(&stream);
    let outcome = match read_request(&mut reader) {
        Ok(o) => o,
        Err(_) => return, // I/O error or timeout: drop the connection
    };
    let mut stream_out = stream;
    let resp = match outcome {
        ReadOutcome::Request(req) => handlers::handle(&req, peer_ip, &cfg.auth),
        ReadOutcome::Eof => return,
        ReadOutcome::BadRequest(code, msg) => Response::error(code, msg),
    };
    let _ = resp.write(&mut stream_out, false);
}
