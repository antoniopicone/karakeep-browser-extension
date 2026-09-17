const statusEl = document.getElementById('status');
const testConnectionBtn = document.getElementById('testConnection');
const crawlToggle = document.getElementById('crawlToggle');
const importFileInput = document.getElementById('importFile');
const importStatusEl = document.getElementById('importStatus');
const CRAWL_ORIGINS = ['https://*/*', 'http://*/*'];

function applyI18n() {
  document.title = chrome.i18n.getMessage('optionsTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
    if (msg) el.textContent = msg;
  });
}

function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.className = ok ? 'ok' : 'err';
}

applyI18n();

// There's no port or secret to configure anymore: the extension talks to
// its embedded reading-list-syncd daemon over Chrome Native Messaging (see
// native-client.js), which Chrome itself scopes to this extension's fixed
// ID — nothing left here to type in. This button just calls the daemon and
// reports whether it answered, for troubleshooting the native-messaging
// host / background service install (see the main README).
testConnectionBtn.addEventListener('click', async () => {
  setStatus(chrome.i18n.getMessage('statusConnecting'), true);
  try {
    const data = await syncdState();
    setStatus(chrome.i18n.getMessage('statusConnectionOk').replace('{count}', (data.entries || []).length), true);
  } catch (err) {
    console.error('syncd connection test failed:', err);
    setStatus(`${chrome.i18n.getMessage('statusConnectionFailed')} (${err.message})`, false);
  }
});

// The mini-crawler's broad host permission (any http/https origin, needed
// to fetch a bookmarked page's own HTML) can ONLY be requested during a
// real user gesture in a page context — calling chrome.permissions.request
// from the background service worker always fails with "This function must
// be called during a user gesture", since service workers aren't part of
// the DOM's gesture-propagation chain. This checkbox click is that gesture;
// background.js only ever checks chrome.permissions.contains, never
// requests.
chrome.permissions.contains({ origins: CRAWL_ORIGINS }, (has) => {
  crawlToggle.checked = has;
});

crawlToggle.addEventListener('change', () => {
  if (crawlToggle.checked) {
    chrome.permissions.request({ origins: CRAWL_ORIGINS }, (granted) => {
      crawlToggle.checked = granted; // snap back if the user declined the prompt
    });
  } else {
    chrome.permissions.remove({ origins: CRAWL_ORIGINS });
  }
});

// ---------------------------------------------------------------- import
//
// Plain text, one URL per line (blank lines and "#" comments ignored,
// duplicates dropped) — deliberately simple, matching what most "export my
// bookmarks/reading list as a text file" tools produce. Each valid URL goes
// through the exact same path as the "+" button (client-side metadata
// extraction isn't possible here — no tab to read — so it always falls
// back to the mini-crawler, if the permission above is granted; otherwise
// the URL itself is used as the title, same as any other add would).
function parseUrlList(text) {
  const seen = new Set();
  const urls = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let parsed;
    try {
      parsed = new URL(line);
    } catch {
      continue; // not an absolute URL — silently skipped, counted at the end
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    if (seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    urls.push(parsed.href);
  }
  return urls;
}

importFileInput.addEventListener('change', async () => {
  const file = importFileInput.files[0];
  importFileInput.value = ''; // allow re-selecting the same file later
  if (!file) return;

  const text = await file.text();
  const urls = parseUrlList(text);
  if (urls.length === 0) {
    importStatusEl.textContent = chrome.i18n.getMessage('importNoUrls');
    return;
  }

  let added = 0;
  let failed = 0;
  // Sequential, not parallel: each add is its own Native Messaging call
  // (a fresh bridge process per chrome.runtime.sendMessage, see
  // native-client.js) — awaiting one at a time keeps that to one at a time
  // too, instead of spawning dozens of bridge processes at once.
  for (let i = 0; i < urls.length; i++) {
    importStatusEl.textContent = chrome.i18n
      .getMessage('importProgress')
      .replace('{current}', i + 1)
      .replace('{total}', urls.length);
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'add-bookmark',
        url: urls[i],
        title: null,
        tabId: null,
        silent: true,
      });
      if (response && response.success) added++; else failed++;
    } catch {
      failed++;
    }
  }

  importStatusEl.textContent = chrome.i18n
    .getMessage('importDone')
    .replace('{added}', added)
    .replace('{failed}', failed);
});
