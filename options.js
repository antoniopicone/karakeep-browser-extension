const baseUrlInput = document.getElementById('baseUrl');
const apiKeyInput = document.getElementById('apiKey');
const statusEl = document.getElementById('status');

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

function normalizeBaseUrl(raw) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  return url.replace(/\/+$/, ''); // remove trailing slashes
}

function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.className = ok ? 'ok' : 'err';
}

applyI18n();

// Pre-fill the fields with the saved values
chrome.storage.local.get(['baseUrl', 'apiKey'], (data) => {
  if (data.baseUrl) baseUrlInput.value = data.baseUrl;
  if (data.apiKey) apiKeyInput.value = data.apiKey;
});

document.getElementById('save').addEventListener('click', async () => {
  const baseUrl = normalizeBaseUrl(baseUrlInput.value);
  const apiKey = apiKeyInput.value.trim();

  if (!baseUrl || !apiKey) {
    setStatus(chrome.i18n.getMessage('statusMissingFields'), false);
    return;
  }

  let origin;
  try {
    origin = new URL(baseUrl).origin + '/*';
  } catch (e) {
    setStatus(chrome.i18n.getMessage('statusInvalidUrl'), false);
    return;
  }

  // Requests the host permission ONLY for this domain, at runtime.
  chrome.permissions.request({ origins: [origin] }, (granted) => {
    if (!granted) {
      setStatus(chrome.i18n.getMessage('statusPermissionDenied'), false);
      return;
    }
    chrome.storage.local.set({ baseUrl, apiKey }, () => {
      setStatus(chrome.i18n.getMessage('statusSaved'), true);
    });
  });
});
