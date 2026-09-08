const portInput = document.getElementById('port');
const authTokenInput = document.getElementById('authToken');
const statusEl = document.getElementById('status');
const crawlToggle = document.getElementById('crawlToggle');
const CRAWL_ORIGINS = ['https://*/*', 'http://*/*'];

function applyI18n() {
  document.title = chrome.i18n.getMessage('optionsTitle');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n-placeholder'));
    if (msg) el.setAttribute('placeholder', msg);
  });
}

function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.className = ok ? 'ok' : 'err';
}

applyI18n();

// Pre-fill the fields with the saved values
chrome.storage.local.get(['port', 'authToken'], (data) => {
  if (data.port) portInput.value = data.port;
  if (data.authToken) authTokenInput.value = data.authToken;
});

document.getElementById('save').addEventListener('click', () => {
  const port = parseInt(portInput.value, 10);
  const authToken = authTokenInput.value.trim();

  if (!port) {
    setStatus(chrome.i18n.getMessage('statusMissingFields'), false);
    return;
  }
  if (port < 1 || port > 65535) {
    setStatus(chrome.i18n.getMessage('statusInvalidPort'), false);
    return;
  }

  // No permission request needed here: http://127.0.0.1/* is a fixed
  // manifest host permission (Chrome match patterns have no port field, so
  // it already covers syncd on any port), granted once at install time.
  chrome.storage.local.set({ port, authToken }, () => {
    setStatus(chrome.i18n.getMessage('statusSaved'), true);
  });
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
