# Reading List – Chromium extension

Shows your saved links in Chrome's side panel, with full-text search, infinite scroll, and image previews — a bit like Safari/macOS's Reading List.

There's no central server: the extension only ever talks to **`syncd`** (from [serverless-sync](https://github.com/antoniopicone/serverless-sync)), a small process running on `127.0.0.1` on the same machine. `syncd` in turn keeps itself in sync with the same process running on your other devices, peer-to-peer over your [Tailscale](https://tailscale.com) tailnet — there is nothing to host, no account, and no third-party server involved.

## 1. Install and run `syncd`

`syncd` needs to be running locally before the extension has anything to show. It's a single self-contained binary.

### Build it

Requires [Rust](https://rustup.rs/) (`cargo`).

```bash
git clone https://github.com/antoniopicone/serverless-sync.git
cd serverless-sync
cargo build --release
# binary at ./target/release/syncd
```

### Run it

```bash
./target/release/syncd \
  --device my-laptop \
  --data-dir ~/.syncd \
  --auth-token "$(openssl rand -hex 24)"
```

- `--device <name>` — a unique name for this device (used for conflict resolution between devices).
- `--port <n>` — **preconfigured to `47100`**, matching the extension's default; only pass this if you need to change it (e.g. running more than one instance on the same machine). This is the only value you then also need to change in the extension's settings.
- `--data-dir <path>` (or env `SYNCD_DATA_DIR`) — **persists state to disk** (`<path>/<device>.json`, atomically written) so your links survive a restart. Without it, `syncd` keeps everything in memory only.
- `--auth-token <secret>` (or env `SYNCD_AUTH_TOKEN`) — protects the local read/write endpoints the extension calls with a bearer token, so another local process/user on the same machine can't read or edit your list. Paste the same value into the extension's "Auth token" field. Optional, but recommended.
- `--bootstrap host:port,...` — comma-separated addresses of other devices to sync with, if they're not auto-discovered via Tailscale.

Keep it running in the background for the extension to always have something to talk to. [`service/`](service/) has ready-to-use setups so it starts automatically instead of needing a terminal tab open: a `make install-service` target (systemd `--user`) on Linux, a `launchd` plist on macOS, and a Scheduled Task installer on Windows. To sync across devices, run the same command (with a different `--device` name) on each one, all joined to the same Tailscale tailnet; see the [serverless-sync README](https://github.com/antoniopicone/serverless-sync) for the multi-device/Tailscale setup.

## 2. Install the extension (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Click the extension's icon in the toolbar: the side panel opens
5. The first time, it will ask you to configure the connection → click "Open settings"
6. The **port** field is pre-filled with `47100` (syncd's default) — only change it if you started `syncd` with a different `--port`. If you set `--auth-token` when running `syncd`, paste the same value into **Auth token**.
7. Save — the panel starts talking to `syncd` on `127.0.0.1` right away, no extra permission prompt needed (that domain is already granted in the manifest)

The interface automatically follows the browser's language: Italian if Chrome is set to Italian, English otherwise (English fallback for other languages too, since these are the only two localizations included).

## Side panel on the left

**This can't be done via manifest/API for a single extension** — Chrome only exposes this option at the browser level, for *all* side panels together (not per-extension):

`chrome://settings/appearance` → **"Show side panel on the left"**

Once enabled there, "Reading List" will also open on the left alongside Reading List, Bookmarks, and the other native panels.

## Replacing the native Reading List

Chrome doesn't let an extension physically replace the "Reading list" panel, but the side panel has a dropdown menu at the top to choose which panel to show. "Reading List" will appear there as a selectable option, and Chrome remembers the last panel opened between sessions.

## Automatic refresh (polling) and cross-device updates

`syncd` has no way to push events into the browser, so the extension polls it every minute (via `chrome.alarms`, which wakes the service worker even if Chrome has suspended it), fetching `GET /v1/state` and diffing it against what it saw on the previous poll:

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

All of them show a confirmation (or error) system notification and write the entry to `syncd` via `POST /v1/write`.

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

Right-click on an item in the list (inside the side panel) → "Remove from Reading List". This doesn't use Chrome's native context menu (which would only expose the link's URL): it's a small panel-specific menu, which also has an "Open in new tab" entry. Removal writes a tombstone to `syncd` via `POST /v1/write` and removes the entry from the list as soon as it's confirmed — and, per the section above, it's also propagated to the list when a *different* device performs the removal.

## Technical notes

- APIs used, all against `syncd` on `127.0.0.1` (never a remote server): `GET /v1/state` (full list + fingerprint), `POST /v1/write` (add/update/delete one entry, `value: null` for a delete)
- syncd's own peer-to-peer sync (over Tailscale) is what actually reconciles state between your devices; this extension only ever reads/writes the local replica
- Port and auth token are saved in `chrome.storage.local` (never synced to Google's servers)
- `http://127.0.0.1/*` is a fixed host permission in the manifest (covers syncd on any port), granted once at install time — no per-domain prompt like the previous, Karakeep-backed version of this extension needed
- Search and filtering happen entirely client-side over the full `/v1/state` response: syncd has no server-side search, but a personal reading list is small enough that this is instant

## Possible future extensions

- A way to add/edit tags from the panel and filter the list by them (the data model already carries a `tags` array, just nothing writes to it yet)
- Sync with `chrome://bookmarks` via the `bookmarks` permission
- More languages (just add a folder in `_locales/`)
