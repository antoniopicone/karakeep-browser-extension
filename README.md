# Reading List – Chromium extension

Shows your saved links in Chrome's side panel, with full-text search, infinite scroll, and image previews — a bit like Safari/macOS's Reading List.

There's no central server, and no generic multi-app daemon either: this project embeds its own dedicated sync daemon, **`reading-list-syncd`** (source under [`native/`](native/), a scoped-down fork of [serverless-sync](https://github.com/antoniopicone/serverless-sync)'s design), built for exactly this one extension. It keeps your reading list in a plain **CSV ledger** on disk — `~/.reading-list/reading-list.csv` by default, one row per change, readable (and, carefully, editable) with any text editor or spreadsheet, not just an internal cache — and syncs that ledger peer-to-peer with the same daemon running on your other devices, over your [Tailscale](https://tailscale.com) tailnet or plain LAN broadcast. Nothing to host, no account, no third-party server.

The extension itself never opens a network connection to talk to it: it goes through Chrome's **Native Messaging** instead (`chrome.runtime.sendNativeMessage`), which Chrome gates to this exact extension's ID on its own — there's no port or secret to type into a settings page anymore.

## 1. Build and install `reading-list-syncd`

Requires [Rust](https://rustup.rs/) (`cargo`).

```bash
git clone https://github.com/antoniopicone/karakeep-browser-extension.git
cd karakeep-browser-extension
make install
```

`make install` builds the daemon (`cargo build --release` in `native/reading-list-syncd/`, no submodule to fetch — it's plain source checked into this repo) and installs two things:

1. **The background daemon**, as a systemd `--user` service on Linux (see [`service/`](service/) for the macOS `launchd` / Windows Scheduled Task equivalents) — it starts on login, restarts on failure, owns the CSV ledger, and does the actual peer-to-peer sync.
2. **A Native Messaging host manifest**, telling Chrome it's allowed to spawn `reading-list-syncd` (bridge mode) on this extension's behalf. Pinned to this extension's fixed ID (`abnldgaciobpabmoffpkalojiihoollj`, baked into `manifest.json`'s `"key"` so it's the same on every machine you load it on).

Split into `make install-service` / `make install-native-host` if you only need one. Useful overrides: `SYNCD_DEVICE` (defaults to your hostname), `SYNCD_PORT` (defaults to `47100`, only the peer-to-peer side needs this — nothing in the extension does anymore), `SYNCD_DATA_DIR` (defaults to `~/.reading-list`), `SYNCD_BOOTSTRAP` (comma-separated `host:port,...` for devices not auto-discovered via Tailscale). `make status-service` / `make logs-service` / `make uninstall` round it out.

## 2. Install the extension (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Click the extension's icon in the toolbar: the side panel opens and starts talking to `reading-list-syncd` right away — no settings to fill in

If it can't reach the daemon (native host not installed, or the service isn't running), the panel shows a setup message instead of an error; the options page also has a **"Test connection"** button for troubleshooting — see [`service/README.md`](service/README.md).

The interface automatically follows the browser's language: Italian if Chrome is set to Italian, English otherwise (English fallback for other languages too, since these are the only two localizations included).

## Syncing across devices

Repeat step 1 on every device you want kept in sync (with a different `SYNCD_DEVICE` each time — it's just a conflict-resolution label), all reachable over the same Tailscale tailnet or LAN. There's no pairing step: any two `reading-list-syncd` instances that can reach each other over the network sync automatically, the same way two `syncd` instances would — see serverless-sync's README for the discovery mechanics (tailnet, LAN broadcast, peer exchange) reused here as-is (`native/reading-list-syncd/src/discovery.rs`, copied verbatim).

**Security note:** unlike serverless-sync's own per-application secret, peer-to-peer traffic between `reading-list-syncd` instances is currently **unencrypted at this layer** — it relies on Tailscale's own WireGuard tunnel for the primary transport; the LAN-broadcast fallback is meant for a trusted home network only. Loopback-only binding plus Chrome's Native Messaging origin check replace the old secret for the *local* side (extension ↔ daemon), which is the part that changed with this rewrite. If you need encrypted peer traffic on an untrusted LAN, that's a gap worth closing before relying on it there — see `native/reading-list-syncd/src/main.rs`'s module doc comment.

## Side panel on the left

**This can't be done via manifest/API for a single extension** — Chrome only exposes this option at the browser level, for *all* side panels together (not per-extension):

`chrome://settings/appearance` → **"Show side panel on the left"**

Once enabled there, "Reading List" will also open on the left alongside Reading List, Bookmarks, and the other native panels.

## Replacing the native Reading List

Chrome doesn't let an extension physically replace the "Reading list" panel, but the side panel has a dropdown menu at the top to choose which panel to show. "Reading List" will appear there as a selectable option, and Chrome remembers the last panel opened between sessions.

## Automatic refresh (polling) and cross-device updates

`reading-list-syncd` has no way to push events into the browser, so the extension polls it every minute (via `chrome.alarms`, which wakes the service worker even if Chrome has suspended it), fetching its full `state` and diffing it against what it saw on the previous poll:

- **New links** (added here, or synced in from another device over the tailnet): if the side panel **is open**, the list reloads automatically and silently, no confirmation required; if it's **not open**, a numeric badge appears on the toolbar icon and clears automatically when the panel is reopened.
- **Removed links** (deleted here, or on another device): an open panel drops them from the list immediately, without waiting for a manual reload.

The panel-open case doesn't rely on knowing whether the panel is "connected" in any stateful way — the background script simply tries to message it and falls back to the badge only if nothing is listening. This is deliberate: Chrome can suspend and respawn the extension's service worker at any time (it isn't tied to whether the panel is visible), so any state that tries to track "is the panel currently open" independently of an actual live message would eventually drift and go stale.

## Extension icon and quick add

**It's not possible** to draw a custom icon inside the address bar, in the same row as Chrome's native bookmark star — that area is native browser UI, not exposed by any API to extensions. The only attachment point granted to an extension is its single `action` icon, which appears in the extensions strip next to the address bar (not inside it).

That's why the extension icon has a single behavior, with no hidden shortcuts: **click → open/close Reading List**.

To quickly add the current page, there are three real alternatives:

1. **Keyboard shortcut**: `Ctrl+Shift+K` (macOS: `Cmd+Shift+K`) — the closest thing to "an always-available button," customizable at `chrome://extensions/shortcuts`.
2. **Right-click on the page or on a link** → "Add to Reading List".
3. **"+" button in the side panel**: handy when the panel is already open, with visual ✓/✕ feedback and an immediate list update.

All of them show a confirmation (or error) system notification and write the entry via a native-messaging `write` call (see `native-client.js`).

## Light/dark theme and the "+" button

Chrome **does not expose to extensions** the color of the active theme (confirmed directly by a Chrome DevRel on an official forum) — but light/dark detection is available via the CSS `prefers-color-scheme` media query, which is reliably supported in extension pages (side panel included). The whole interface already uses it to adapt background, text, borders, and tag colors.

The "+" button follows the same principle: no fixed color, just a border that uses the active text color (`--fg`), so it's light on a dark background and dark on a light background, automatically. The icon is the extension's bookmark with a "+" in the middle.

## Client-side metadata extraction

When possible, the extension reads title, description, image, and favicon **directly from the tab's DOM** (via `chrome.scripting.executeScript`) at the moment you add a link, instead of waiting for the fallback crawler below. The entry then appears in the list already with real data, without having to wait for or force a reload.

This requires the `activeTab` permission for that specific tab, which Chrome only reliably grants for certain gestures:

- ✅ **Context menu on the page** (right-click → "Add to Reading List")
- ✅ **Keyboard shortcut** (`Ctrl+Shift+K`)
- ⚠️ **"+" button in the side panel**: there's a known Chrome limitation where `activeTab` isn't always granted when the gesture happens inside a side panel instead of on the extension's icon/menu/shortcut. In this case the extraction fails silently and falls back to a mini-crawler (the extension fetches the page's own HTML client-side and reads its `<title>`/OG tags) — no visible error, just a slightly longer delay before richer metadata shows up.

For links found via the context menu (right-click on a link, not on the page), client-side extraction isn't possible — we don't have the DOM of the destination page — so it always goes through the mini-crawler. The mini-crawler needs the optional "Fetch missing metadata automatically" permission (toggle in Settings), since it fetches arbitrary pages.

## Removing a link

Right-click on an item in the list (inside the side panel) → "Remove from Reading List". This doesn't use Chrome's native context menu (which would only expose the link's URL): it's a small panel-specific menu, which also has an "Open in new tab" entry. Removal writes a tombstone via the same native-messaging `write` call (`value: null`) and removes the entry from the list as soon as it's confirmed — and, per the section above, it's also propagated to the list when a *different* device performs the removal.

## Importing a list of URLs

Settings → **Import**: pick a plain text file, one URL per line (blank lines and `#` comments are ignored, duplicates dropped). Each valid `http(s)` URL is added exactly the way the "+" button would — client-side DOM extraction isn't possible for an imported URL (there's no tab open on it), so it always goes through the mini-crawler above if that permission is granted, or falls back to the URL itself as the title otherwise. Added silently (no per-link notification — the options page's own progress line is the feedback) and one at a time, since each add is its own Native Messaging call; a large file will take a few seconds, not be instant.

## The CSV ledger

`~/.reading-list/reading-list.csv` (or wherever `--data` points) is not an internal cache — it's the actual source of truth, an append-only log with one row per change: `device,seq,entity,kind,value,hlc`. `entity` is the bookmark's URL, `value` its JSON blob (title/description/image/favicon/tags/note/timestamps), `kind` is `upsert` or `delete`, `hlc` a hybrid logical clock used to deterministically resolve conflicts between devices. Reading it externally (a script, a spreadsheet, `grep`) is fine; editing it while the daemon is stopped is fine too (it's replayed from scratch on the next start) — editing it *while the daemon is running* will be silently overwritten by the in-memory state on the next write, since the daemon never re-reads the file after startup. There's no compaction: the log only grows (see `native/reading-list-syncd/README` — inherited from serverless-sync's own reasoning about why a CRDT op log can't just drop old rows).

## Technical notes

- The extension never opens a network connection of its own to sync: everything goes through Chrome's Native Messaging (`chrome.runtime.sendNativeMessage`, see `native-client.js`) to `reading-list-syncd`, a background daemon this project embeds (source under `native/`), not a generic multi-app service.
- Two messages, both JSON: `{ type: "write", entity, value }` (`value: null` to delete) → `{ seq, vv }`; `{ type: "state" }` → `{ device, entries: [{entity, value}, ...], vv, fingerprint }`. The native host process itself is short-lived — Chrome spawns it fresh per call and it just relays this one message to the long-running daemon's loopback HTTP API (see `native/reading-list-syncd/src/main.rs`'s module doc comment for why it has to work that way).
- `reading-list-syncd`'s own peer-to-peer sync (over Tailscale or LAN broadcast) is what actually reconciles the CSV ledger between your devices; the extension only ever reads/writes the local replica through the bridge above.
- Nothing is stored in `chrome.storage.local` for the sync connection anymore (no port, no secret) — Chrome's Native Messaging `allowed_origins` (pinned to this extension's fixed ID, see `manifest.json`'s `"key"`) plus the daemon's loopback-only local API are what gate access instead.
- No `host_permissions` needed anymore either (the old `http://127.0.0.1/*` entry is gone) — Native Messaging doesn't go through the extension's fetch/XHR permission model at all.
- Search and filtering happen entirely client-side over the full `state` response: the daemon has no server-side search, but a personal reading list is small enough that this is instant.

## Possible future extensions

- A way to add/edit tags from the panel and filter the list by them (the data model already carries a `tags` array, just nothing writes to it yet)
- Sync with `chrome://bookmarks` via the `bookmarks` permission
- More languages (just add a folder in `_locales/`)
- Encrypting `reading-list-syncd`'s peer-to-peer traffic (currently relies on Tailscale's own transport encryption — see "Syncing across devices" above)
