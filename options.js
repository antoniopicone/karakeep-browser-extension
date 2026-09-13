const statusEl = document.getElementById('status');
const testConnectionBtn = document.getElementById('testConnection');
const crawlToggle = document.getElementById('crawlToggle');
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
