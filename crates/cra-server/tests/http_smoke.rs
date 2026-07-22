//! End-to-end HTTP tests: spawn the built server on an ephemeral port and
//! drive it with a tiny std-only HTTP client.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command};
use std::time::Duration;

struct Server {
    child: Child,
    port: u16,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn(extra_env: &[(&str, &str)]) -> Server {
    // Pick a port by binding then releasing.
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let bin = env!("CARGO_BIN_EXE_cra-server");
    let mut cmd = Command::new(bin);
    cmd.env("CRA_ADDR", format!("127.0.0.1:{port}"));
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let child = cmd.spawn().expect("spawn server");
    // Wait for the port to accept.
    for _ in 0..100 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Server { child, port };
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("server did not start");
}

/// Minimal HTTP/1.1 request; returns (status, body).
fn request(port: u16, raw: &str) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(raw.as_bytes()).unwrap();
    let mut resp = Vec::new();
    s.read_to_end(&mut resp).unwrap();
    let text = String::from_utf8_lossy(&resp).into_owned();
    let status = text
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let body = text.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
    (status, body)
}

fn post(port: u16, path: &str, body: &str, headers: &str) -> (u16, String) {
    let raw = format!(
        "POST {path} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n{body}",
        body.len()
    );
    request(port, &raw)
}

fn get(port: u16, path: &str) -> (u16, String) {
    request(port, &format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"))
}

#[test]
fn healthz_and_analyze() {
    let srv = spawn(&[]);
    let (st, body) = get(srv.port, "/healthz");
    assert_eq!(st, 200);
    assert_eq!(body, "ok");

    let model = r#"{"model":{"type":"fault_tree","top":"t",
        "events":[{"id":"a","dist":{"type":"fixed","q":0.1}},
                  {"id":"b","dist":{"type":"fixed","q":0.1}}],
        "gates":[{"id":"t","op":"and","inputs":["a","b"]}]}}"#;
    let (st, body) = post(srv.port, "/api/analyze", model, "Content-Type: application/json\r\n");
    assert_eq!(st, 200, "body = {body}");
    assert!(body.contains("\"top_probability\":0.01"), "body = {body}");
}

#[test]
fn invalid_json_is_400() {
    let srv = spawn(&[]);
    let (st, _) = post(srv.port, "/api/analyze", "{not json", "");
    assert_eq!(st, 400);
}

#[test]
fn engine_validation_error_is_422() {
    let srv = spawn(&[]);
    // lambda negative -> engine rejects with a validation error.
    let model = r#"{"model":{"type":"fault_tree","top":"a",
        "events":[{"id":"a","dist":{"type":"exponential","lambda":-1}}],
        "gates":[]}}"#;
    let (st, body) = post(srv.port, "/api/analyze", model, "Content-Type: application/json\r\n");
    assert_eq!(st, 422, "body = {body}");
}

#[test]
fn unknown_route_is_404() {
    let srv = spawn(&[]);
    let (st, _) = get(srv.port, "/does-not-exist");
    assert_eq!(st, 404);
}

#[test]
fn example_endpoint_serves_json() {
    let srv = spawn(&[]);
    let (st, body) = get(srv.port, "/api/examples/fault_tree");
    assert_eq!(st, 200);
    assert!(body.contains("fault_tree"));
    let (st, _) = get(srv.port, "/api/examples/nope");
    assert_eq!(st, 404);
}

#[test]
fn token_auth_enforced() {
    let srv = spawn(&[("CRA_AUTH", "token"), ("CRA_TOKEN", "supersecret123")]);
    // No token -> 401.
    let (st, _) = post(srv.port, "/api/analyze", "{}", "Content-Type: application/json\r\n");
    assert_eq!(st, 401);
    // Static assets remain public.
    let (st, _) = get(srv.port, "/style.css");
    assert_eq!(st, 200);
    // Correct token -> passes auth (400 for the empty body, not 401).
    let (st, _) = post(
        srv.port,
        "/api/analyze",
        "{}",
        "Content-Type: application/json\r\nAuthorization: Bearer supersecret123\r\n",
    );
    assert_eq!(st, 400);
}

#[test]
fn oversized_body_rejected() {
    let srv = spawn(&[]);
    // Claim a Content-Length beyond MAX_BODY (64 MiB) -> 413 before reading.
    let raw = format!(
        "POST /api/analyze HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        100 * 1024 * 1024
    );
    let (st, _) = request(srv.port, &raw);
    assert_eq!(st, 413);
}
