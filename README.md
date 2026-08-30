# Reading List (Karakeep) – Chromium extension

Shows the links saved on your Karakeep instance in Chrome's side panel, with full-text search, infinite scroll, and image previews — a bit like Safari/macOS's Reading List.

## Installation (developer mode)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Click the extension's icon in the toolbar: the side panel opens
5. The first time, it will ask you to configure the instance → click "Open settings"
6. Enter your Karakeep instance URL (e.g. `https://karakeep.anto.sh`) and the API key (Karakeep → Settings → API Keys)
7. Save: you'll be asked for permission to access that domain (required only for that domain, not for the whole web)

The interface automatically follows the browser's language: Italian if Chrome is set to Italian, English otherwise (English fallback for other languages too, since these are the only two localizations included).

## Side panel on the left

**This can't be done via manifest/API for a single extension** — Chrome only exposes this option at the browser level, for *all* side panels together (not per-extension):

`chrome://settings/appearance` → **"Show side panel on the left"**

Once enabled there, "Reading List" will also open on the left alongside Reading List, Bookmarks, and the other native panels.

## Replacing the native Reading List

Chrome doesn't let an extension physically replace the "Reading list" panel, but the side panel has a dropdown menu at the top to choose which panel to show. "Reading List" will appear there as a selectable option, and Chrome remembers the last panel opened between sessions.

## Automatic refresh (polling)

The extension checks every minute (via `chrome.alarms`, which wakes up the service worker even if Chrome has suspended it) whether new links have appeared on Karakeep, by comparing the last seen `createdAt` with the most recent one returned by `GET /api/v1/bookmarks`.

- If the side panel **is open**: the list reloads automatically and silently, with no confirmation required.
- If the side panel **is not open**: a numeric badge appears on the toolbar icon, which clears automatically when the panel is reopened.

**About webhooks**: Karakeep supports outgoing webhooks (`bookmark.created/updated`, see [configuration docs](https://docs.karakeep.app/configuration/environment-variables/)), but these are calls made by the Karakeep server to a URL you configure — to "push" them all the way to the browser you'd need a small relay (e.g. an endpoint on your homelab that receives the webhook and forwards it via WebSocket to the extension's service worker). The 60s polling covers the same need with much less infrastructure complexity; if you want the push-based version with a relay on your homelab in the future, it's a natural extension of this base.

## Extension icon and quick add

**It's not possible** to draw a custom icon inside the address bar, in the same row as Chrome's native bookmark star — that area is native browser UI, not exposed by any API to extensions. The only attachment point granted to an extension is its single `action` icon, which appears in the extensions strip next to the address bar (not inside it).

That's why the extension icon has a single behavior, with no hidden shortcuts: **click → open/close Reading List**.

To quickly add the current page, there are three real alternatives:

1. **Keyboard shortcut**: `Ctrl+Shift+K` (macOS: `Cmd+Shift+K`) — the closest thing to "an always-available button," customizable at `chrome://extensions/shortcuts`.
2. **Right-click on the page or on a link** → "Add to Reading List".
3. **"+" button in the side panel**: handy when the panel is already open, with visual ✓/✕ feedback and an immediate list update.

All of them show a confirmation (or error) system notification and use `POST /api/v1/bookmarks`.

## Light/dark theme and the "+" button

Chrome **does not expose to extensions** the color of the active theme (confirmed directly by a Chrome DevRel on an official forum) — but light/dark detection is available via the CSS `prefers-color-scheme` media query, which is reliably supported in extension pages (side panel included). The whole interface already uses it to adapt background, text, borders, and tag colors.

The "+" button follows the same principle: no fixed color, just a border that uses the active text color (`--fg`), so it's light on a dark background and dark on a light background, automatically. The icon is the extension's bookmark with a "+" in the middle.

## Client-side metadata extraction

When possible, the extension reads title, description, image, and favicon **directly from the tab's DOM** (via `chrome.scripting.executeScript`) at the moment you add a link, instead of waiting for Karakeep's crawler. The entry then appears in the list already with real data, without having to wait for or force a reload.

This requires the `activeTab` permission for that specific tab, which Chrome only reliably grants for certain gestures:

- ✅ **Context menu on the page** (right-click → "Add to Reading List")
- ✅ **Keyboard shortcut** (`Ctrl+Shift+K`)
- ⚠️ **"+" button in the side panel**: there's a known Chrome limitation where `activeTab` isn't always granted when the gesture happens inside a side panel instead of on the extension's icon/menu/shortcut. In this case the extraction fails silently and falls back to the previous behavior (server-side crawl + polling every 2s) — no visible error, just a slightly longer delay before the metadata shows up.

For links found via the context menu (right-click on a link, not on the page), client-side extraction isn't possible — we don't have the DOM of the destination page — so it always goes through Karakeep's crawler.

## Removing a link

Right-click on an item in the list (inside the side panel) → "Remove from Reading List". This doesn't use Chrome's native context menu (which would only expose the link's URL, not the bookmark's id on Karakeep): it's a small panel-specific menu, which also has an "Open in new tab" entry. Removal calls `DELETE /api/v1/bookmarks/{id}` and removes the entry from the list as soon as it's confirmed.

## What's new in this version

- **Fix: missing metadata after quick add** — Karakeep creates the bookmark immediately but downloads title/image/description asynchronously. Now, after an add (via "+", context menu, or shortcut), the extension polls the single bookmark every 2 seconds (up to ~16s) until crawling is finished, then reloads the list again automatically — no need to force a manual reload.

- **Infinite scroll**: the next page loads automatically as you scroll, no more "Load more" button
- **Image preview**: uses `content.imageUrl` if Karakeep saved it as a direct external URL; otherwise downloads `content.imageAssetId`/`screenshotAssetId` via `GET /api/v1/assets/{id}` with authentication and shows it as a blob URL (falling back to a generic icon if the asset isn't available)
- **Rebrand**: name "Reading List" (IT: "Elenco lettura"), new bookmark icon
- **Multilingual**: UI strings localized in Italian and English via `chrome.i18n` (`_locales/it`, `_locales/en`)

## Technical notes

- APIs used: `GET /api/v1/bookmarks` (list), `GET /api/v1/bookmarks/search?q=...` (full-text search), `GET /api/v1/assets/{id}` (image preview when there's no direct `imageUrl`)
- The list excludes archived bookmarks (`archived=false`) and only shows those of type `link`
- API key and URL are saved in `chrome.storage.local` (never synced to Google's servers)
- Host permission requested at runtime only for your instance's domain
- The asset download endpoint isn't unambiguously documented publicly in the REST API v1: if previews don't load, open the side panel's developer tools (right-click on the panel → Inspect) and check the Network tab to verify the exact path on your version of Karakeep

## Possible future extensions

- Filter by Karakeep tag/list
- Badge with new links count
- Sync with `chrome://bookmarks` via the `bookmarks` permission
- More languages (just add a folder in `_locales/`)
