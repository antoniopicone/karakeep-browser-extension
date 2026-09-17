//! reading-list-syncd — the embedded, single-purpose sync daemon behind the
//! Reading List browser extension.
//!
//! Design lineage: this is a scoped-down fork of
//! github.com/antoniopicone/serverless-sync's `syncd` (see core.rs and
//! discovery.rs, copied verbatim from there — main.rs and persist.rs are
//! adapted here). The difference is deliberate: serverless-sync's `syncd`
//! is one generic daemon meant to host many independent applications behind
//! a registration handshake; this binary hosts exactly one dataset (this
//! extension's reading list) with no registry, no per-app secret, and no
//! HTTP surface exposed directly to the browser. Two run modes:
//!
//!   reading-list-syncd serve [--device NAME] [--port N] [--data PATH]
//!                             [--bootstrap host:port,...] [--advertise ADDR]
//!                             [--peer-prefix PREFIX] [--no-lan-discovery]
//!       The long-running background daemon (installed as a systemd/launchd/
//!       Task Scheduler service — see service/): owns the CSV ledger, runs
//!       the peer-to-peer anti-entropy loop against other devices, and
//!       exposes a small loopback-only HTTP control API on `--port`.
//!
//!   reading-list-syncd
//!       (no "serve" subcommand — this is exactly how Chrome invokes it as
//!       a Native Messaging host, per its own host manifest) Bridge mode:
//!       relays length-prefixed JSON messages on stdin/stdout (Chrome's
//!       Native Messaging framing) to the already-running `serve` daemon's
//!       loopback HTTP API. Chrome spawns this fresh per
//!       chrome.runtime.connectNative() call and kills it when the port
//!       disconnects, so it cannot itself be the long-running P2P daemon —
//!       that's what `serve` is for. The two find each other via a small
//!       `port` sidecar file `serve` writes next to the CSV ledger (see
//!       persist::port_file_path), since Chrome controls the bridge's argv
//!       and can't be told a custom `--port`.
//!
//! Peer-to-peer traffic is unencrypted in this version (unlike
//! serverless-sync's per-application ChaCha20-Poly1305 envelopes): the
//! primary transport (Tailscale) already runs inside its own WireGuard
//! tunnel, and the LAN-broadcast fallback is opt-in and intended for a
//! trusted home network. Loopback-only local control plus Chrome's own
//! Native Messaging origin check (see the host manifest) replace the old
//! per-application secret for the local side. Revisit if this daemon ever
//! needs to defend a genuinely untrusted LAN.

mod core;
mod discovery;
mod persist;

use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use core::{Op, OpKind, Replica, VersionVector};
use discovery::{Peer, PexCache};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PROTO: u32 = 1;
const DEFAULT_PORT: u16 = 47100;

fn arg(args: &[String], k: &str) -> Option<String> {
    let eq_prefix = format!("{k}=");
    args.iter().find_map(|a| a.strip_prefix(&eq_prefix).map(String::from)).or_else(|| {
        args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned()
    })
}

#[derive(Clone)]
struct App {
    replica: Arc<Mutex<Replica>>,
    log: Arc<persist::OpLog>,
    device: String,
    hostname: String,
    port: u16,
    advertise: String,
    peer_prefix: String,
    pex: PexCache,
}

fn apply_and_persist(app: &App, op: Op) -> bool {
    let applied = app.replica.lock().unwrap().apply(op.clone());
    if applied {
        if let Err(e) = app.log.append(&op) {
            eprintln!("[persist] failed to append op ({} seq {}): {e}", op.device, op.seq);
        }
    }
    applied
}

// ---------------------------------------------------------- local control
// (loopback-only: this is what the native-messaging bridge, run on this
// same machine on this extension's behalf, actually calls)

async fn require_loopback(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: axum::extract::Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if addr.ip().is_loopback() {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::FORBIDDEN)
    }
}

#[derive(Deserialize)]
struct WriteReq {
    entity: String,
    value: Option<String>,
}

#[derive(Serialize)]
struct WriteResp {
    seq: u64,
    vv: VersionVector,
}

async fn local_write(State(app): State<App>, Json(req): Json<WriteReq>) -> Json<WriteResp> {
    let device = app.device.clone();
    let op = {
        let mut replica = app.replica.lock().unwrap();
        match req.value {
            Some(v) => replica.local_change(&req.entity, OpKind::Upsert, &v),
            None => replica.local_change(&req.entity, OpKind::Delete, ""),
        }
    };
    let _ = device;
    if let Err(e) = app.log.append(&op) {
        eprintln!("[persist] failed to append local op (seq {}): {e}", op.seq);
    }
    let vv = app.replica.lock().unwrap().version_vector();
    Json(WriteResp { seq: op.seq, vv })
}

#[derive(Serialize)]
struct StateResp {
    device: String,
    entries: Vec<serde_json::Value>,
    vv: VersionVector,
    fingerprint: String,
}

async fn local_state(State(app): State<App>) -> Json<StateResp> {
    let replica = app.replica.lock().unwrap();
    Json(StateResp {
        device: app.device.clone(),
        entries: replica.entries(),
        vv: replica.version_vector(),
        fingerprint: format!("{:x}", replica.state_fingerprint()),
    })
}

// ------------------------------------------------------------ peer-to-peer
// (reachable from the LAN/tailnet — same shapes as serverless-sync's
// per-application endpoints, minus the (name, token) path segment and the
// encryption envelope; see the module doc comment for why.)

#[derive(Serialize)]
struct NodeInfo {
    proto: u32,
    device_id: String,
    hostname: String,
    port: u16,
    entries: usize,
    fingerprint: String,
}

async fn node(State(app): State<App>) -> Json<NodeInfo> {
    let replica = app.replica.lock().unwrap();
    Json(NodeInfo {
        proto: PROTO,
        device_id: app.device.clone(),
        hostname: app.hostname.clone(),
        port: app.port,
        entries: replica.entries().len(),
        fingerprint: format!("{:x}", replica.state_fingerprint()),
    })
}

#[derive(Serialize, Deserialize, Default)]
struct PexReq {
    #[serde(default)]
    peers: Vec<Peer>,
}

async fn peers(State(app): State<App>, Json(req): Json<PexReq>) -> Json<Vec<Peer>> {
    app.pex.merge(req.peers);
    let me = app.device.clone();
    let mut out: Vec<Peer> = app.pex.list().into_iter().filter(|p| p.device_id != me).collect();
    out.push(Peer { hostname: app.hostname.clone(), addr: app.advertise.clone(), device_id: me });
    Json(out)
}

async fn vv(State(app): State<App>) -> Json<VersionVector> {
    Json(app.replica.lock().unwrap().version_vector())
}

#[derive(Serialize, Deserialize)]
struct SinceReq {
    vv: VersionVector,
}

#[derive(Serialize, Deserialize)]
struct OpsResp {
    ops: Vec<Op>,
}

async fn ops_since(State(app): State<App>, Json(req): Json<SinceReq>) -> Json<OpsResp> {
    let ops = app.replica.lock().unwrap().ops_since(&req.vv);
    Json(OpsResp { ops })
}

#[derive(Serialize, Deserialize)]
struct PushReq {
    ops: Vec<Op>,
}

#[derive(Serialize, Deserialize)]
struct PushResp {
    applied: usize,
    vv: VersionVector,
}

async fn ops_push(State(app): State<App>, Json(req): Json<PushReq>) -> Json<PushResp> {
    let mut ops = req.ops;
    ops.sort_by_key(|o| (o.device.clone(), o.seq));
    let applied = ops.into_iter().filter(|o| apply_and_persist(&app, o.clone())).count();
    let vv = app.replica.lock().unwrap().version_vector();
    Json(PushResp { applied, vv })
}

// ------------------------------------------------------------ sync client

async fn sync_round(app: &App, addr: &str) -> Result<(usize, usize), String> {
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;

    let my_vv = app.replica.lock().unwrap().version_vector();
    let pulled: OpsResp = http
        .post(format!("http://{addr}/v1/ops/since"))
        .json(&SinceReq { vv: my_vv })
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    let mut ops = pulled.ops;
    ops.sort_by_key(|o| (o.device.clone(), o.seq));
    let n_pull = ops.into_iter().filter(|o| apply_and_persist(app, o.clone())).count();

    let their_vv: VersionVector = http
        .post(format!("http://{addr}/v1/vv"))
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    let mine = app.replica.lock().unwrap().ops_since(&their_vv);
    let n_push = if mine.is_empty() {
        0
    } else {
        let resp: PushResp = http
            .post(format!("http://{addr}/v1/ops"))
            .json(&PushReq { ops: mine })
            .send().await.map_err(|e| e.to_string())?
            .json().await.map_err(|e| e.to_string())?;
        resp.applied
    };

    Ok((n_pull, n_push))
}

async fn exchange_peers(app: &App, addr: &str) {
    let Ok(http) = reqwest::Client::builder().timeout(std::time::Duration::from_secs(2)).build() else { return };
    let mut mine_peers = app.pex.list();
    mine_peers.push(Peer { hostname: app.hostname.clone(), addr: app.advertise.clone(), device_id: app.device.clone() });
    if let Ok(resp) = http.post(format!("http://{addr}/v1/peers")).json(&PexReq { peers: mine_peers }).send().await {
        if let Ok(list) = resp.json::<Vec<Peer>>().await {
            app.pex.merge(list);
        }
    }
}

async fn antientropy_loop(app: App, bootstrap: Vec<String>, interval_secs: u64) {
    loop {
        let mut targets: Vec<String> = bootstrap.clone();
        for (_host, ip) in discovery::tailnet_candidates(&app.peer_prefix) {
            targets.push(format!("{ip}:{}", app.port));
        }
        for p in app.pex.list() {
            targets.push(p.addr);
        }
        targets.sort();
        targets.dedup();

        for t in targets.into_iter().filter(|t| *t != app.advertise) {
            exchange_peers(&app, &t).await;
            match sync_round(&app, &t).await {
                Ok((pulled, pushed)) => {
                    if pulled + pushed > 0 {
                        println!("[sync] <-> {t}: +{pulled} received, +{pushed} sent");
                    }
                }
                Err(e) => eprintln!("[sync] <-> {t}: unreachable ({e})"),
            }
        }

        tokio::time::sleep(std::time::Duration::from_secs(interval_secs)).await;
    }
}

// -------------------------------------------------------------- serve mode

async fn run_serve(args: Vec<String>) {
    let device = arg(&args, "--device").unwrap_or_else(|| "device-1".into());
    let port: u16 = arg(&args, "--port").and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
    let bootstrap: Vec<String> = arg(&args, "--bootstrap")
        .map(|b| b.split(',').map(String::from).collect())
        .unwrap_or_default();
    let data_path: PathBuf = arg(&args, "--data").map(PathBuf::from).unwrap_or_else(persist::default_csv_path);
    let peer_prefix = arg(&args, "--peer-prefix").unwrap_or_default();
    let lan_discovery_enabled = !args.iter().any(|a| a == "--no-lan-discovery");

    let hostname = std::process::Command::new("hostname")
        .output().ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| device.clone());

    let lan_ip = discovery::local_lan_ip();
    let advertise = arg(&args, "--advertise")
        .or_else(|| std::env::var("READING_LIST_ADVERTISE").ok())
        .or_else(|| discovery::my_tailnet_ip().map(|ip| format!("{ip}:{port}")))
        .or_else(|| lan_ip.map(|ip| format!("{ip}:{port}")))
        .unwrap_or_else(|| format!("127.0.0.1:{port}"));

    let mut replica = Replica::new(device.clone());
    match persist::load(&data_path) {
        Ok(ops) => {
            let n = ops.len();
            for op in ops {
                replica.apply(op);
            }
            if n > 0 {
                println!("[persist] replayed {n} ops from {}", data_path.display());
            }
        }
        Err(e) => eprintln!("[persist] failed to read {}: {e} (starting empty)", data_path.display()),
    }
    let log = persist::OpLog::open(&data_path)
        .unwrap_or_else(|e| panic!("[persist] cannot open {}: {e}", data_path.display()));

    let data_dir = data_path.parent().map(PathBuf::from).unwrap_or_else(persist::default_data_dir);
    if let Err(e) = persist::write_port_file(&data_dir, port) {
        eprintln!("[persist] could not write port file next to {}: {e} (the native-messaging bridge may not find this daemon)", data_path.display());
    }

    let app = App {
        replica: Arc::new(Mutex::new(replica)),
        log: Arc::new(log),
        device: device.clone(),
        hostname,
        port,
        advertise: advertise.clone(),
        peer_prefix,
        pex: PexCache::default(),
    };

    println!("reading-list-syncd serve: device={device} port={port} advertise={advertise} data={}", data_path.display());

    let mut local_api = Router::new()
        .route("/write", post(local_write))
        .route("/state", get(local_state));
    local_api = local_api.layer(middleware::from_fn(require_loopback));

    let sync_api = Router::new()
        .route("/v1/node", get(node))
        .route("/v1/peers", post(peers))
        .route("/v1/vv", post(vv))
        .route("/v1/ops/since", post(ops_since))
        .route("/v1/ops", post(ops_push));

    let router = local_api.merge(sync_api).with_state(app.clone());

    tokio::spawn(antientropy_loop(app.clone(), bootstrap, 10));
    if lan_discovery_enabled {
        let me = Peer { hostname: app.hostname.clone(), addr: app.advertise.clone(), device_id: app.device.clone() };
        tokio::spawn(discovery::lan_discovery_loop(me, app.peer_prefix.clone(), app.pex.clone(), std::time::Duration::from_secs(5)));
    }

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await
        .unwrap_or_else(|e| panic!("cannot bind port {port}: {e}"));
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .unwrap();
}

// ------------------------------------------------- native messaging bridge
//
// Chrome's Native Messaging framing: each message is a 4-byte length
// prefix (native byte order — little-endian on every platform Chrome
// actually ships on) followed by that many bytes of UTF-8 JSON. Chrome
// spawns this process fresh per chrome.runtime.connectNative() call (per
// the host manifest's "path") and closes stdin when the port disconnects,
// which is our own signal to exit — see the module doc comment for why
// this can't itself be the long-running daemon.

async fn read_message<R: AsyncReadExt + Unpin>(r: &mut R) -> std::io::Result<Option<serde_json::Value>> {
    let mut len_buf = [0u8; 4];
    if let Err(e) = r.read_exact(&mut len_buf).await {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            return Ok(None);
        }
        return Err(e);
    }
    let len = u32::from_le_bytes(len_buf) as usize;
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    Ok(serde_json::from_slice(&buf).ok())
}

async fn write_message<W: AsyncWriteExt + Unpin>(w: &mut W, value: &serde_json::Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    w.write_all(&(bytes.len() as u32).to_le_bytes()).await?;
    w.write_all(&bytes).await?;
    w.flush().await
}

async fn run_bridge() {
    let data_dir = persist::default_data_dir();
    let port = persist::read_port_file(&data_dir).unwrap_or(DEFAULT_PORT);
    let base = format!("http://127.0.0.1:{port}");
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .expect("building the local HTTP client cannot fail");

    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();

    loop {
        let msg = match read_message(&mut stdin).await {
            Ok(Some(m)) => m,
            Ok(None) => break, // Chrome closed the port
            Err(e) => {
                let _ = write_message(&mut stdout, &serde_json::json!({ "error": format!("bridge read failed: {e}") })).await;
                break;
            }
        };

        let response = handle_bridge_message(&http, &base, msg).await;
        if write_message(&mut stdout, &response).await.is_err() {
            break; // Chrome closed the port from its side
        }
    }
}

async fn handle_bridge_message(http: &reqwest::Client, base: &str, msg: serde_json::Value) -> serde_json::Value {
    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let result = match msg_type {
        "write" => {
            http.post(format!("{base}/write"))
                .json(&serde_json::json!({ "entity": msg.get("entity"), "value": msg.get("value") }))
                .send().await
        }
        "state" => http.get(format!("{base}/state")).send().await,
        other => {
            return serde_json::json!({ "error": format!("unknown message type {other:?}") });
        }
    };

    match result {
        Ok(res) if res.status().is_success() => {
            res.json::<serde_json::Value>().await.unwrap_or_else(|e| serde_json::json!({ "error": format!("bad response from daemon: {e}") }))
        }
        Ok(res) => serde_json::json!({ "error": format!("daemon returned HTTP {}", res.status()) }),
        Err(e) => serde_json::json!({
            "error": if e.is_connect() {
                "reading-list-syncd isn't running — is the background service started?".to_string()
            } else {
                format!("could not reach reading-list-syncd: {e}")
            }
        }),
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("serve") {
        run_serve(args).await;
    } else {
        // Any other invocation — including exactly what Chrome uses to
        // launch a Native Messaging host, which appends its own argv
        // (the extension's origin, and on Windows a window handle) that we
        // don't otherwise care about.
        run_bridge().await;
    }
}
