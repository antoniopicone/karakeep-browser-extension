# reading-list-syncd

The embedded, single-purpose sync daemon behind the Reading List browser
extension (see the [top-level README](../../README.md) for the user-facing
picture). A scoped-down fork of
[serverless-sync](https://github.com/antoniopicone/serverless-sync)'s
design: `src/core.rs` (the CRDT reducer) and `src/discovery.rs` (peer
discovery over Tailscale/LAN broadcast/PEX) are copied verbatim from there —
that project's own README explicitly documents `core.rs` as the intended
reuse point. `src/main.rs` and `src/persist.rs` are written for this project:
one dataset instead of a multi-application registry, no per-application
secret/registration handshake, and two run modes instead of a single HTTP
server.

## Modes

```
reading-list-syncd serve [--device NAME] [--port N] [--data PATH]
                          [--bootstrap host:port,...] [--advertise ADDR]
                          [--peer-prefix PREFIX] [--no-lan-discovery]
```
The long-running background daemon (installed as a systemd/launchd/Task
Scheduler service — see [`../../service/`](../../service/)): owns the CSV
ledger, runs the peer-to-peer anti-entropy loop against other devices, and
exposes a small loopback-only HTTP control API on `--port` (default
`47100`).

```
reading-list-syncd
```
No `serve` — this is exactly how Chrome invokes it as a Native Messaging
host. Bridge mode: relays length-prefixed JSON messages on stdin/stdout
(Chrome's [Native Messaging
framing](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging))
to the already-running `serve` daemon's loopback HTTP API. Chrome spawns
this fresh per `chrome.runtime.connectNative()`/`sendNativeMessage()` call
and kills it when the port disconnects, so it cannot itself be the
long-running P2P daemon. The two find each other via a small `port`
sidecar file `serve` writes next to the CSV ledger, since Chrome controls
the bridge's argv and can't be told a custom `--port`.

Bridge-mode messages: `{ "type": "write", "entity": "...", "value": "..." | null }`
→ `{ "seq": u64, "vv": {...} }`, and `{ "type": "state" }` → `{ "device",
"entries": [{entity, value}, ...], "vv", "fingerprint" }`.

## The CSV ledger

One row per accepted change (local or synced from a peer), appended as it
happens, at `--data` (default `~/.reading-list/reading-list.csv`):
`device,seq,entity,kind,value,hlc`. This is the actual source of truth, not
a cache — on startup, `serve` replays every row through `core::Replica::apply`
to rebuild the in-memory state. No compaction: see serverless-sync's README
for why a CRDT op log can't just drop old rows without also shrinking what
a far-behind peer's `/v1/ops/since` can still answer.

## HTTP surface

Local control (loopback-only — this is what bridge mode calls):

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/write` | `{ entity, value }` (`value: null` to delete) | `{ seq, vv }` |
| GET | `/state` | – | `{ device, entries, vv, fingerprint }` |

Peer-to-peer (reachable from the LAN/tailnet, no loopback restriction —
same shapes as serverless-sync's per-application endpoints, minus the
`(name, token)` path segment and the encryption envelope):

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/v1/node` | – | `{ proto, device_id, hostname, port, entries, fingerprint }` |
| POST | `/v1/peers` | `{ peers }` | `[Peer, ...]` |
| POST | `/v1/vv` | – | `VersionVector` |
| POST | `/v1/ops/since` | `{ vv }` | `{ ops }` |
| POST | `/v1/ops` | `{ ops }` | `{ applied, vv }` |

## Known limitation: no peer-to-peer encryption (yet)

Unlike serverless-sync's per-application ChaCha20-Poly1305 envelopes, P2P
traffic here is plaintext. The primary transport (Tailscale) already runs
inside its own WireGuard tunnel; the LAN-broadcast fallback is opt-in and
intended for a trusted home network. Loopback-only local control plus
Chrome's own Native Messaging origin check (`allowed_origins` in the host
manifest, pinned to the extension's fixed ID) replace the old per-application
secret for the local side. Revisit (bring `crypto.rs` back from
serverless-sync, same as `core.rs`/`discovery.rs`) if this daemon ever needs
to defend a genuinely untrusted LAN.

## A bug found and fixed here (not present in this form upstream... yet)

`core.rs`'s `apply()` updates the version vector but not the local `seq`
counter `local_change()` mints the next op from. Replaying a device's own
past ops through `apply()` at startup (exactly what `persist::load`'s
replay does) left `seq` at 0 while the version vector correctly reflected
the true high-water mark — the first local write after a restart then
reused an already-used seq number and regressed the version vector, which a
peer that had already synced past the real value would read as a stale
duplicate and silently drop. Fixed here by bumping `self.seq` in `apply()`
whenever the op belongs to `self.device`. Worth reporting upstream to
serverless-sync too, since `main.rs` there replays the same way.
