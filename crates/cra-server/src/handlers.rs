//! Маршрутизация запросов и обработчики адресов (endpoints).

use std::net::IpAddr;

use cra::Request as AnalysisRequest;

use crate::assets;
use crate::audit::{self, AuditRecord};
use crate::auth::{AuthMode, AuthResult};
use crate::http::{Request, Response, MAX_BODY};

/// Какие адреса требуют входа. Статические файлы открыты, so the login page
/// can load. Защищаем только /api/.
fn is_protected(path: &str) -> bool {
    path.starts_with("/api/")
}

/// Главный обработчик: проверить вход, выбрать маршрут, записать в журнал.
pub fn handle(req: &Request, peer: IpAddr, auth: &AuthMode) -> Response {
    // Сначала проверяем вход для защищённых адресов.
    let principal = if is_protected(&req.path) {
        match auth.authenticate(req, peer) {
            AuthResult::Ok(p) => p,
            AuthResult::Denied(reason) => {
                audit::log(&AuditRecord {
                    event: "auth_denied",
                    peer: &peer.to_string(),
                    principal: "-",
                    method: &req.method,
                    path: &req.path,
                    status: 401,
                    detail: reason,
                });
                let www = matches!(auth, AuthMode::Token { .. });
                let mut resp = Response::error(401, reason);
                if www {
                    resp = resp.with_header("WWW-Authenticate", "Bearer");
                }
                return resp;
            }
        }
    } else {
        "anonymous".to_string()
    };

    let resp = route(req, &principal);

    if is_protected(&req.path) {
        audit::log(&AuditRecord {
            event: "request",
            peer: &peer.to_string(),
            principal: &principal,
            method: &req.method,
            path: &req.path,
            status: resp.status,
            detail: "",
        });
    }
    resp
}

/// Выбор ответа по методу и адресу (простая таблица маршрутов).
fn route(req: &Request, principal: &str) -> Response {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/healthz") => Response::text(200, "ok"), // проверка "жив ли"
        ("POST", "/api/analyze") => analyze(req, principal),
        ("GET", p) if p.starts_with("/api/examples/") => {
            let name = &p["/api/examples/".len()..];
            match assets::example(name) {
                Some(c) => Response::json(200, c.as_bytes().to_vec()),
                None => Response::error(404, "unknown example"),
            }
        }
        ("GET", p) | ("HEAD", p) => match assets::find(p) {
            Some(a) => Response::new(200, a.content_type, a.bytes.to_vec()),
            None => Response::error(404, "not found"),
        },
        (_, "/api/analyze") => Response::error(405, "method not allowed"),
        _ => Response::error(405, "method not allowed"),
    }
}

/// Обработчик /api/analyze: читаем JSON, считаем, отдаём JSON.
fn analyze(req: &Request, principal: &str) -> Response {
    if req.body.len() > MAX_BODY {
        return Response::error(413, "payload too large"); // слишком большой запрос
    }
    let parsed: Result<AnalysisRequest, _> = serde_json::from_slice(&req.body);
    let request = match parsed {
        Ok(r) => r,
        Err(e) => return Response::error(400, &format!("invalid request JSON: {e}")),
    };
    // Analysis is CPU-bound and can be large; run it and translate engine
    // errors (validation failures) into 422.
    match cra::analyze_request(&request) {
        Ok(resp) => match serde_json::to_vec(&resp) {
            Ok(body) => Response::json(200, body),
            Err(e) => {
                audit::log(&AuditRecord {
                    event: "error",
                    peer: "-",
                    principal,
                    method: "POST",
                    path: "/api/analyze",
                    status: 500,
                    detail: &e.to_string(),
                });
                Response::error(500, "failed to serialize response")
            }
        },
        Err(e) => Response::error(422, &e),
    }
}
