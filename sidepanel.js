const els = {
  search: document.getElementById('searchInput'),
  list: document.getElementById('linkList'),
  loading: document.getElementById('loading'),
  error: document.getElementById('errorBox'),
  empty: document.getElementById('emptyState'),
  notConfigured: document.getElementById('notConfigured'),
  openOptions: document.getElementById('openOptions'),
  content: document.getElementById('content'),
  addCurrentTab: document.getElementById('addCurrentTab'),
  panelContextMenu: document.getElementById('panelContextMenu'),
  panelMenuOpen: document.getElementById('panelMenuOpen'),
  panelMenuDelete: document.getElementById('panelMenuDelete'),
};

const NO_IMAGE_SVG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
  );

// "Bookmark with a + in the middle" icon for the quick-add button,
// consistent with the extension's icon.
const ADD_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" width="18" height="18">' +
  '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>' +
  '<line x1="12" y1="6.5" x2="12" y2="12.5"/>' +
  '<line x1="9" y1="9.5" x2="15" y2="9.5"/>' +
  '</svg>';

let config = { port: null, authToken: null };
let currentQuery = '';
let requestSeq = 0;
let isFetching = false;
let allLinks = []; // everything syncd currently has, newest first

function applyI18n() {
  document.title = chrome.i18n.getMessage('extName');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.setAttribute('placeholder', msg);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    const msg = chrome.i18n.getMessage(key);
    if (msg) { el.setAttribute('title', msg); el.setAttribute('aria-label', msg); }
  });
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function setState({ loading = false, error = null, notConfigured = false } = {}) {
  hide(els.loading); hide(els.error); hide(els.notConfigured); hide(els.empty);
  if (notConfigured) { show(els.notConfigured); return; }
  if (loading) show(els.loading);
  if (error) { els.error.textContent = error; show(els.error); }
}

function hostFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

function parseValue(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function setThumb(imgEl, link) {
  if (link.imageUrl) {
    imgEl.src = link.imageUrl;
    imgEl.classList.remove('no-image');
    imgEl.onerror = () => showNoImage(imgEl);
  } else {
    showNoImage(imgEl);
  }
}

function showNoImage(imgEl) {
  imgEl.classList.add('no-image');
  imgEl.src = NO_IMAGE_SVG;
  imgEl.onerror = null;
}

function createLinkEl(link) {
  const a = document.createElement('a');
  a.className = 'link-item';
  a.href = link.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.dataset.url = link.url;

  const thumb = document.createElement('img');
  thumb.className = 'link-thumb';
  thumb.alt = '';
  setThumb(thumb, link);

  const textWrap = document.createElement('div');
  textWrap.className = 'link-text';

  const titleEl = document.createElement('div');
  titleEl.className = 'link-title';
  titleEl.textContent = link.title || link.url;

  const metaEl = document.createElement('div');
  metaEl.className = 'link-meta';
  if (link.favicon) {
    const fav = document.createElement('img');
    fav.className = 'link-favicon';
    fav.src = link.favicon;
    fav.alt = '';
    fav.onerror = () => { fav.style.visibility = 'hidden'; };
    metaEl.appendChild(fav);
  }
  const hostEl = document.createElement('span');
  hostEl.className = 'link-host';
  hostEl.textContent = hostFromUrl(link.url);
  metaEl.appendChild(hostEl);

  textWrap.appendChild(titleEl);
  textWrap.appendChild(metaEl);

  if (link.description) {
    const descEl = document.createElement('div');
    descEl.className = 'link-description';
    descEl.textContent = link.description;
    textWrap.appendChild(descEl);
  }

  if (link.tags && link.tags.length) {
    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'link-tags';
    for (const tag of link.tags.slice(0, 4)) {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.textContent = tag;
      tagsWrap.appendChild(pill);
    }
    textWrap.appendChild(tagsWrap);
  }

  a.appendChild(thumb);
  a.appendChild(textWrap);
  return a;
}

function renderItems(links) {
  els.list.innerHTML = '';
  if (links.length === 0) {
    show(els.empty);
    return;
  }
  hide(els.empty);
  const frag = document.createDocumentFragment();
  for (const link of links) {
    frag.appendChild(createLinkEl(link));
  }
  els.list.appendChild(frag);
}

function renderFiltered() {
  const q = currentQuery.toLowerCase();
  const filtered = !q
    ? allLinks
    : allLinks.filter((l) =>
        (l.title || '').toLowerCase().includes(q) ||
        (l.url || '').toLowerCase().includes(q) ||
        (l.description || '').toLowerCase().includes(q) ||
        (l.tags || []).some((t) => t.toLowerCase().includes(q))
      );
  renderItems(filtered);
}

async function apiFetch(path) {
  const url = `http://127.0.0.1:${config.port}${path}`;
  const headers = { Accept: 'application/json' };
  if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(chrome.i18n.getMessage('fetchErrorText'));
  }
  return res.json();
}

// Everything comes from a single local call: no cursor, no server-side
// search — syncd has no concept of either, and a personal bookmark list is
// small enough that filtering the whole thing in the panel is instant.
async function loadPage() {
  if (isFetching) return;
  const seq = ++requestSeq;

  isFetching = true;
  setState({ loading: true });

  try {
    const data = await apiFetch('/v1/state');
    if (seq !== requestSeq) return;

    allLinks = (data.entries || [])
      .map((e) => parseValue(e.value))
      .filter((v) => v && v.url)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    setState({});
    renderFiltered();

    // Opening the panel counts as having seen everything: update the
    // reference and clear badge/banner.
    if (allLinks.length) {
      chrome.storage.local.set({ lastSeenUpdatedAt: allLinks[0].updatedAt, pendingNewCount: 0 });
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (err) {
    if (seq !== requestSeq) return;
    setState({ error: err.message || String(err) });
  } finally {
    isFetching = false;
  }
}

els.search.addEventListener('input', () => {
  currentQuery = els.search.value.trim();
  renderFiltered(); // local filter over an already-fetched list: no debounce needed
});

els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

// The background (chrome.alarms, every minute) notifies us via a runtime
// message when it detects new links: we reload the list silently, with no
// banner or confirmation from the user.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'syncd-new-links') {
    chrome.action.setBadgeText({ text: '' });
    loadPage();
  } else if (msg && msg.type === 'syncd-optimistic-add') {
    prependOptimisticLink(msg.link);
  } else if (msg && msg.type === 'syncd-bookmark-deleted') {
    removeLinkFromDom(msg.url);
  }
});

// Immediately shows the just-added entry with the metadata extracted
// client-side (title/description/image/favicon), without waiting for
// either a network call or the mini-crawler. Once that finishes, the
// normal reload (triggered by the background script) replaces it with the
// enriched version.
function prependOptimisticLink(link) {
  if (currentQuery) return; // don't disturb an ongoing search
  hide(els.empty);
  const el = createLinkEl(link);
  el.classList.add('is-pending');
  els.list.insertBefore(el, els.list.firstChild);
}

function removeLinkFromDom(url) {
  const el = els.list.querySelector(`.link-item[data-url="${CSS.escape(url)}"]`);
  if (el) el.remove();
  if (!els.list.children.length) show(els.empty);
}

async function addCurrentTab() {
  if (!config.port) {
    chrome.runtime.openOptionsPage();
    return;
  }
  setAddButtonState('loading');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) {
      throw new Error('Invalid tab URL');
    }

    // Delegate the add to the background: it also handles the mini-crawler
    // fallback and notifies us again once metadata is enriched.
    const response = await chrome.runtime.sendMessage({
      type: 'add-bookmark',
      url: tab.url,
      title: tab.title,
      tabId: tab.id,
    });

    if (!response || !response.success) throw new Error('Add failed');
    setAddButtonState('success');
    // The background will notify us (syncd-new-links) both right away and
    // after the mini-crawler runs: no need to reload manually here.
  } catch (err) {
    console.error('Adding current page failed:', err);
    setAddButtonState('error');
  } finally {
    setTimeout(() => setAddButtonState('idle'), 1500);
  }
}

function setAddButtonState(state) {
  const btn = els.addCurrentTab;
  btn.classList.remove('is-loading', 'is-success', 'is-error');
  if (state === 'loading') { btn.classList.add('is-loading'); btn.textContent = '…'; }
  else if (state === 'success') { btn.classList.add('is-success'); btn.textContent = '✓'; }
  else if (state === 'error') { btn.classList.add('is-error'); btn.textContent = '✕'; }
  else { btn.innerHTML = ADD_ICON_SVG; }
}

els.addCurrentTab.addEventListener('click', addCurrentTab);

async function init() {
  applyI18n();

  // Signal to the background that the panel is open (used to decide
  // whether to reload silently or show the badge when new links arrive).
  chrome.runtime.connect({ name: 'sidepanel' });

  const data = await new Promise((resolve) =>
    chrome.storage.local.get(['port', 'authToken'], resolve)
  );

  setAddButtonState('idle');

  if (!data.port) {
    setState({ notConfigured: true });
    return;
  }

  config = data;
  await loadPage();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.port || changes.authToken)) {
    init();
  }
});

// Custom context menu on the list's links: right-click → "Open in new tab" /
// "Remove from Reading List". We don't use the native chrome.contextMenus
// API for this because it only exposes the link's href, and we want a
// dedicated "Remove" action scoped to this panel.
let contextMenuTarget = null; // { url }

function openPanelContextMenu(x, y, target) {
  contextMenuTarget = target;
  const menu = els.panelContextMenu;
  show(menu);

  // Keeps the menu within the panel's bounds.
  const { innerWidth, innerHeight } = window;
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, innerWidth - rect.width - 8);
  const top = Math.min(y, innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function closePanelContextMenu() {
  hide(els.panelContextMenu);
  contextMenuTarget = null;
}

els.list.addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.link-item');
  if (!item) return;
  e.preventDefault();
  openPanelContextMenu(e.clientX, e.clientY, { url: item.dataset.url || item.href });
});

document.addEventListener('click', (e) => {
  if (!els.panelContextMenu.contains(e.target)) closePanelContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePanelContextMenu();
});
els.content.addEventListener('scroll', closePanelContextMenu);

els.panelMenuOpen.addEventListener('click', () => {
  if (contextMenuTarget) chrome.tabs.create({ url: contextMenuTarget.url });
  closePanelContextMenu();
});

els.panelMenuDelete.addEventListener('click', async () => {
  const target = contextMenuTarget;
  closePanelContextMenu();
  if (!target || !target.url) return;

  const item = els.list.querySelector(`.link-item[data-url="${CSS.escape(target.url)}"]`);
  if (item) item.classList.add('is-pending'); // immediate feedback while the request is in flight

  try {
    const response = await chrome.runtime.sendMessage({ type: 'delete-bookmark', url: target.url });
    if (response && response.success) {
      removeLinkFromDom(target.url);
    } else if (item) {
      item.classList.remove('is-pending'); // restore if the deletion failed
    }
  } catch (err) {
    console.error('Deletion failed:', err);
    if (item) item.classList.remove('is-pending');
  }
});

init();
