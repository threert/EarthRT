//! `net.fetch` on the host channel (ThreeRT docs/RUNTIME.md "The host channel"): the globe script asks the registry
//! (`/api/v1/...`) and the tiles' `meta.json` for JSON, and the app makes the request. HTTPS only (and `http://` to
//! the loopback, for a local `wrangler dev` given as `api=`), a text body up to 8 MiB, at most 16 under way (more
//! are refused with an answer that says so: the script retries on its own schedule).
//!
//! The answer is the engine's: `{ t: "net.fetched", id, status, body, error? }`, `status` 0 when the request failed.
//! Sockets (`net.open`) are not the globe's: refused with a `net.closed`, as an app without them does.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;
use threert_render::host::HostServices;

pub const MAX_FETCHES: usize = 16;
const MAX_BODY: u64 = 8 << 20;
const TIMEOUT: Duration = Duration::from_secs(30);

/// Whether a script may ask `url`: `https://` anywhere, `http://` only to this machine.
pub fn allowed(url: &str) -> Result<(), String> {
    let l = url.to_ascii_lowercase();
    if l.starts_with("https://") {
        return Ok(());
    }
    if let Some(rest) = l.strip_prefix("http://") {
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        let host = host.rsplit_once(':').map_or(host, |(h, p)| if p.chars().all(|c| c.is_ascii_digit()) { h } else { host });
        if matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
            return Ok(());
        }
    }
    Err(format!("{url}: a request's address is https:// (or http:// to this machine)"))
}

pub struct NetFetch {
    agent: ureq::Agent,
    /// Without the proxy: a request the proxy could not connect is tried again directly.
    direct: Option<ureq::Agent>,
    tx: mpsc::Sender<Value>,
    rx: mpsc::Receiver<Value>,
    running: Arc<AtomicUsize>,
}

impl NetFetch {
    pub fn new(agent: ureq::Agent) -> NetFetch {
        let (tx, rx) = mpsc::channel();
        NetFetch { agent, direct: None, tx, rx, running: Arc::default() }
    }

    /// With a direct agent to fall back on when the (proxied) one cannot connect.
    pub fn with_direct(mut self, direct: ureq::Agent) -> NetFetch {
        self.direct = Some(direct);
        self
    }

    fn fetch(&mut self, m: &Value) {
        let id = m["id"].clone();
        let fail = |why: String| {
            let _ = self.tx.send(json!({ "t": "net.fetched", "id": id, "status": 0, "body": "", "error": why }));
        };
        let Some(url) = m["url"].as_str() else { return fail("net.fetch: no url".into()) };
        if let Err(e) = allowed(url) {
            return fail(e);
        }
        if self.running.load(Ordering::Relaxed) >= MAX_FETCHES {
            return fail(format!("net.fetch: {MAX_FETCHES} requests are under way already"));
        }
        let method = m["method"].as_str().unwrap_or("GET").to_uppercase();
        let headers: Vec<(String, String)> = m["headers"].as_object().map(|h| h.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()).unwrap_or_default();
        let body = m["body"].as_str().map(String::from);
        let (url, tx, running, agent, direct) = (url.to_string(), self.tx.clone(), self.running.clone(), self.agent.clone(), self.direct.clone());
        running.fetch_add(1, Ordering::Relaxed);
        let spawned = std::thread::Builder::new().name("earthrt-fetch".into()).spawn(move || {
            let mut result = request(&agent, &method, &url, &headers, body.clone());
            if let (Err(e), Some(direct)) = (&result, &direct) {
                if e.contains("connect") || e.contains("proxy") || e.contains("timeout") {
                    result = request(direct, &method, &url, &headers, body);
                }
            }
            let answer = match result {
                Ok((status, body)) => json!({ "t": "net.fetched", "id": id, "status": status, "body": body }),
                Err(e) => json!({ "t": "net.fetched", "id": id, "status": 0, "body": "", "error": e }),
            };
            running.fetch_sub(1, Ordering::Relaxed);
            let _ = tx.send(answer);
        });
        if spawned.is_err() {
            self.running.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

/// One request: its status and its body as text.
pub fn request(agent: &ureq::Agent, method: &str, url: &str, headers: &[(String, String)], body: Option<String>) -> Result<(u16, String), String> {
    let mut r = ureq::http::Request::builder().method(method).uri(url);
    let mut has_agent = false;
    for (k, v) in headers {
        has_agent |= k.eq_ignore_ascii_case("user-agent");
        r = r.header(k.as_str(), v.as_str());
    }
    if !has_agent {
        r = r.header("User-Agent", concat!("EarthRT/", env!("CARGO_PKG_VERSION")));
    }
    let bad = |e: ureq::http::Error| format!("net.fetch: {e}");
    let mut response = match body {
        Some(text) => agent.run(r.body(text).map_err(bad)?),
        None => agent.run(r.body(()).map_err(bad)?),
    }
    .map_err(|e| format!("{url}: {e}"))?;
    let status = response.status().as_u16();
    let text = response.body_mut().with_config().limit(MAX_BODY).read_to_string().map_err(|e| format!("{url}: {e}"))?;
    Ok((status, text))
}

/// The app's HTTP agent: statuses are answers, not errors; the system's HTTPS proxy when the app names one.
pub fn agent(proxy: Option<&str>, timeout: Duration) -> ureq::Agent {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let proxy = proxy.filter(|p| !p.is_empty()).and_then(|p| ureq::Proxy::new(p).ok());
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .max_redirects(5)
        .proxy(proxy)
        .build()
        .into()
}

pub fn default_agent() -> ureq::Agent {
    agent(None, TIMEOUT)
}

impl HostServices for NetFetch {
    fn post(&mut self, m: &Value) {
        match m["t"].as_str() {
            Some("net.fetch") => self.fetch(m),
            Some("net.open") => {
                let _ = self.tx.send(json!({ "t": "net.closed", "id": m["id"], "code": 1006, "reason": "the EarthRT app opens no sockets for the globe" }));
            }
            _ => {}
        }
    }

    fn poll(&mut self) -> Vec<Value> {
        self.rx.try_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_a_script_may_ask() {
        assert!(allowed("https://earth.threert.dev/api/v1/places").is_ok());
        assert!(allowed("HTTPS://x.org").is_ok());
        assert!(allowed("http://127.0.0.1:8787/api/v1/places").is_ok());
        assert!(allowed("http://localhost/x").is_ok());
        assert!(allowed("http://example.com/").is_err());
        assert!(allowed("http://127.0.0.1.example.com/").is_err());
        assert!(allowed("file:///etc/passwd").is_err());
        assert!(allowed("ftp://x").is_err());
    }

    fn wait(n: &mut NetFetch, count: usize) -> Vec<Value> {
        let mut got = vec![];
        for _ in 0..300 {
            got.extend(n.poll());
            if got.len() >= count {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        got
    }

    /// A request to a server on this machine is answered with its status and body; refusals are answered too, and
    /// sockets are refused; other families are not this module's.
    #[test]
    fn requests_are_answered() {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = server.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for s in server.incoming().take(1) {
                let mut s = s.unwrap();
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let body = if req.to_ascii_lowercase().contains("user-agent: earthrt/") { r#"{"ok":true}"# } else { r#"{"ok":false}"# };
                write!(s, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let mut n = NetFetch::new(default_agent());
        n.post(&json!({ "t": "net.fetch", "id": "a", "url": format!("http://127.0.0.1:{port}/api/v1/me") }));
        n.post(&json!({ "t": "net.fetch", "id": "b", "url": "http://example.com/" }));
        n.post(&json!({ "t": "net.fetch", "id": "c" }));
        n.post(&json!({ "t": "net.open", "id": "s", "url": "wss://x" }));
        n.post(&json!({ "t": "assets.fetch", "id": "d", "url": "https://x", "path": "cache/x" }));
        let mut got = wait(&mut n, 4);
        got.sort_by_key(|m| m["id"].as_str().map(String::from));
        assert_eq!(got.len(), 4, "{got:?}");
        assert_eq!((got[0]["status"].as_u64(), got[0]["body"].as_str()), (Some(200), Some(r#"{"ok":true}"#)));
        assert!(got[1]["error"].as_str().unwrap().contains("https://"));
        assert_eq!(got[2]["error"].as_str(), Some("net.fetch: no url"));
        assert_eq!((got[3]["t"].as_str(), got[3]["code"].as_u64()), (Some("net.closed"), Some(1006)));
    }
}
