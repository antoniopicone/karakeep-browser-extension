const els = {
  search: document.getElementById('searchInput'),
  list: document.getElementById('linkList'),
  loading: document.getElementById('loading'),
  loadingMore: document.getElementById('loadingMore'),
  error: document.getElementById('errorBox'),
  empty: document.getElementById('emptyState'),
  notConfigured: document.getElementById('notConfigured'),
  openOptions: document.getElementById('openOptions'),
  sentinel: document.getElementById('sentinel'),
  content: document.getElementById('content'),
  addCurrentTab: document.getElementById('addCurrentTab'),
  panelContextMenu: document.getElementById('panelContextMenu'),
  panelMenuOpen: document.getElementById('panelMenuOpen'),
  panelMenuDelete: document.getElementById('panelMenuDelete'),
};

const PAGE_SIZE = 30;
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

let config = { baseUrl: null, apiKey: null };
let currentQuery = '';
let nextCursor = null;
let requestSeq = 0;
let isFetching = false;
const assetUrlCache = new Map(); // assetId -> Promise<objectURL|null>

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

function setState({ loading = false, loadingMore = false, error = null, notConfigured = false } = {}) {
  hide(els.loading); hide(els.error); hide(els.notConfigured); hide(els.empty); hide(els.loadingMore);
  if (notConfigured) { show(els.notConfigured); return; }
  if (loading) show(els.loading);
  if (loadingMore) show(els.loadingMore);
  if (error) { els.error.textContent = error; show(els.error); }
}

function hostFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

function extractLink(bookmark) {
  const content = bookmark.content || {};
  const url = content.url || bookmark.url || '';
  const title = bookmark.title || content.title || url;
  const favicon = content.favicon || null;
  const imageUrl = content.imageUrl || null;
  const imageAssetId = content.imageAssetId || content.screenshotAssetId || null;
  const description = bookmark.summary || content.description || null;
  const tags = (bookmark.tags || []).map((t) => t.name).filter(Boolean);
  return { id: bookmark.id, url, title, favicon, imageUrl, imageAssetId, description, tags };
}

// Assets (screenshot/local image) require the Authorization header, so they
// can't simply be set as the src of an <img>: we download them and turn
// them into blob URLs, with a small in-memory cache.
async function resolveAssetUrl(assetId) {
  if (assetUrlCache.has(assetId)) return assetUrlCache.get(assetId);

  const promise = (async () => {
    try {
      const res = await fetch(`${config.baseUrl}/api/v1/assets/${assetId}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  })();

  assetUrlCache.set(assetId, promise);
  return promise;
}

function setThumb(imgEl, link) {
  if (link.imageUrl) {
    imgEl.src = link.imageUrl;
    imgEl.classList.remove('no-image');
    imgEl.onerror = () => fallbackToAsset(imgEl, link);
    return;
  }
  if (link.imageAssetId) {
    fallbackToAsset(imgEl, link);
    return;
  }
  showNoImage(imgEl);
}

function fallbackToAsset(imgEl, link) {
  if (!link.imageAssetId) { showNoImage(imgEl); return; }
  resolveAssetUrl(link.imageAssetId).then((objUrl) => {
    if (objUrl) {
      imgEl.src = objUrl;
      imgEl.onerror = () => showNoImage(imgEl);
      imgEl.classList.remove('no-image');
    } else {
      showNoImage(imgEl);
    }
  });
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
  a.dataset.bookmarkId = link.id || '';
  a.dataset.url = link.url;

  const thumb = document.createElement('img');
  thumb.className = 'link-thumb';
  thumb.alt = '';
  setThumb(thumb, link);

  const textWrap = document.createElement('div');
  textWrap.className = 'link-text';

  const titleEl = document.createElement('div');
  titleEl.className = 'link-title';
  titleEl.textContent = link.title;

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

function renderItems(bookmarks, append) {
  if (!append) els.list.innerHTML = '';

  const links = bookmarks
    .filter((b) => (b.content && b.content.type === 'link') || b.url)
    .map(extractLink)
    .filter((l) => l.url);

  if (!append && links.length === 0) {
    show(els.empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const link of links) {
    frag.appendChild(createLinkEl(link));
  }
  els.list.appendChild(frag);
}

async function apiFetch(path, params) {
  const url = new URL(config.baseUrl + '/api/v1' + path);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(chrome.i18n.getMessage('fetchErrorText'));
  }
  return res.json();
}

async function loadPage({ reset }) {
  if (isFetching) return;
  const seq = ++requestSeq;
  if (reset) nextCursor = null;
  if (!reset && !nextCursor) return;

  isFetching = true;
  setState({ loading: reset, loadingMore: !reset });

  try {
    const path = currentQuery ? '/bookmarks/search' : '/bookmarks';
    const params = currentQuery
      ? { q: currentQuery, limit: PAGE_SIZE, cursor: nextCursor }
      : { limit: PAGE_SIZE, cursor: nextCursor, archived: 'false' };

    const data = await apiFetch(path, params);
    if (seq !== requestSeq) return;

    setState({});
    renderItems(data.bookmarks || [], !reset);
    nextCursor = data.nextCursor || null;

    if ((data.bookmarks || []).length === 0 && reset) {
      show(els.empty);
    }

    // Opening the panel on the "main" list (no active search) counts as
    // having seen everything: update the reference and clear badge/banner.
    if (reset && !currentQuery && (data.bookmarks || []).length) {
      const newestCreatedAt = data.bookmarks[0].createdAt;
      chrome.storage.local.set({ lastSeenCreatedAt: newestCreatedAt, pendingNewCount: 0 });
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (err) {
    if (seq !== requestSeq) return;
    setState({ error: err.message || String(err) });
  } finally {
    isFetching = false;
  }
}

let debounceTimer;
els.search.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    currentQuery = els.search.value.trim();
    loadPage({ reset: true });
  }, 300);
});

els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

// The background (chrome.alarms, every minute) notifies us via a runtime
// message when it detects new links: we reload the list silently, with no
// banner or confirmation from the user.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'karakeep-new-links') {
    chrome.action.setBadgeText({ text: '' });
    loadPage({ reset: true });
  } else if (msg && msg.type === 'karakeep-optimistic-add') {
    prependOptimisticLink(msg.link);
  } else if (msg && msg.type === 'karakeep-bookmark-deleted') {
    removeLinkFromDom(msg.id);
  }
});

// Immediately shows the just-added entry with the metadata extracted
// client-side (title/description/image/favicon), without waiting for either
// a network call or Karakeep's crawler. Once server-side crawling finishes,
// the normal automatic reload replaces it with the "official" one.
function prependOptimisticLink(rawLink) {
  if (currentQuery) return; // don't disturb an ongoing search
  hide(els.empty);
  const link = {
    id: '',
    url: rawLink.url,
    title: rawLink.title || rawLink.url,
    favicon: rawLink.favicon || null,
    imageUrl: rawLink.imageUrl || null,
    imageAssetId: null,
    description: rawLink.description || null,
    tags: [],
  };
  const el = createLinkEl(link);
  el.classList.add('is-pending');
  els.list.insertBefore(el, els.list.firstChild);
}

function removeLinkFromDom(bookmarkId) {
  const el = els.list.querySelector(`.link-item[data-bookmark-id="${CSS.escape(bookmarkId)}"]`);
  if (el) el.remove();
  if (!els.list.children.length) show(els.empty);
}

async function addCurrentTab() {
  if (!config.baseUrl || !config.apiKey) {
    chrome.runtime.openOptionsPage();
    return;
  }
  setAddButtonState('loading');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) {
      throw new Error('Invalid tab URL');
    }

    // Delegate the add to the background: it also handles polling the
    // crawling status and reloads the list again once metadata is ready.
    const response = await chrome.runtime.sendMessage({
      type: 'add-bookmark',
      url: tab.url,
      title: tab.title,
      tabId: tab.id,
    });

    if (!response || !response.success) throw new Error('Add failed');
    setAddButtonState('success');
    // The background will notify us (karakeep-new-links) both right away
    // and after crawling: no need to reload manually here.
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

// Infinite scroll: when the sentinel at the bottom of the list enters the
// panel's viewport, we automatically load the next page.
const observer = new IntersectionObserver(
  (entries) => {
    if (entries[0].isIntersecting && nextCursor && !isFetching) {
      loadPage({ reset: false });
    }
  },
  { root: els.content, rootMargin: '200px' }
);
observer.observe(els.sentinel);

async function init() {
  applyI18n();

  // Signal to the background that the panel is open (used to decide
  // whether to reload silently or show the badge when new links arrive).
  chrome.runtime.connect({ name: 'sidepanel' });

  const data = await new Promise((resolve) =>
    chrome.storage.local.get(['baseUrl', 'apiKey'], resolve)
  );

  setAddButtonState('idle');

  if (!data.baseUrl || !data.apiKey) {
    setState({ notConfigured: true });
    return;
  }

  config = data;
  await loadPage({ reset: true });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.baseUrl || changes.apiKey)) {
    init();
  }
});

// Custom context menu on the list's links: right-click → "Open in new tab" /
// "Remove from Reading List". We don't use the native chrome.contextMenus
// API for this because it only exposes the link's href, not custom data
// like the bookmark's id on Karakeep.
let contextMenuTarget = null; // { bookmarkId, url }

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

  // "Remove" only makes sense for entries already saved on Karakeep (they
  // have an id); a provisional entry (optimistic add) doesn't have one yet.
  els.panelMenuDelete.disabled = !target.bookmarkId;
  els.panelMenuDelete.style.display = target.bookmarkId ? '' : 'none';
}

function closePanelContextMenu() {
  hide(els.panelContextMenu);
  contextMenuTarget = null;
}

els.list.addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.link-item');
  if (!item) return;
  e.preventDefault();
  openPanelContextMenu(e.clientX, e.clientY, {
    bookmarkId: item.dataset.bookmarkId || '',
    url: item.dataset.url || item.href,
  });
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
  if (!target || !target.bookmarkId) return;

  const item = els.list.querySelector(`.link-item[data-bookmark-id="${CSS.escape(target.bookmarkId)}"]`);
  if (item) item.classList.add('is-pending'); // immediate feedback while the request is in flight

  try {
    const response = await chrome.runtime.sendMessage({ type: 'delete-bookmark', id: target.bookmarkId });
    if (response && response.success) {
      removeLinkFromDom(target.bookmarkId);
    } else if (item) {
      item.classList.remove('is-pending'); // restore if the deletion failed
    }
  } catch (err) {
    console.error('Deletion failed:', err);
    if (item) item.classList.remove('is-pending');
  }
});

init();
