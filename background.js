const ALARM_NAME = 'syncd-poll';
const POLL_MINUTES = 1; // the minimum allowed by chrome.alarms is 1 minute
const CONTEXT_MENU_ADD_ID = 'add-to-reading-list';
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'mc_cid', 'mc_eid',
  'igshid', 'ref', 'ref_src', '_hsenc', '_hsmi',
];

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('setPanelBehavior error:', err));

function ensureAlarm() {
  chrome.alarms.get(ALARM_NAME, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES, delayInMinutes: POLL_MINUTES });
    }
  });
}

function ensureContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ADD_ID,
      title: chrome.i18n.getMessage('contextMenuAdd'),
      contexts: ['page', 'link'],
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  ensureContextMenu();
});
chrome.runtime.onStartup.addListener(ensureAlarm);

// The side panel opens a persistent connection on load and closes it when
// hidden: this way we know for certain whether it's open, instead of
// inferring it from the (unreliable) outcome of chrome.runtime.sendMessage.
const openPanels = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  openPanels.add(port);
  port.onDisconnect.addListener(() => openPanels.delete(port));
});

// If the config is saved/changed from the options page, (re)start polling
// and run an immediate first check.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.port || changes.authToken)) {
    ensureAlarm();
    checkForNewLinks();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) checkForNewLinks();
});

// If the panel is open, make it reload immediately and silently; otherwise
// show a numeric badge on the icon as the only indicator.
function notifyPanelsOrBadge(count) {
  if (openPanels.size > 0) {
    chrome.runtime.sendMessage({ type: 'syncd-new-links', count }).catch(() => {});
  } else {
    chrome.action.setBadgeText({ text: String(Math.min(count, 99)) });
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  }
}

// ------------------------------------------------------- local syncd client
//
// No central Karakeep server: every call here hits the syncd instance
// running on this same machine (127.0.0.1), which does its own
// peer-to-peer mesh sync with the other devices over Tailscale — see
// serverless-sync's README. This background script only ever talks to
// localhost.

async function syncdConfig() {
  return chrome.storage.local.get(['port', 'authToken']);
}

async function syncdFetch(path, opts = {}) {
  const { port, authToken } = await syncdConfig();
  if (!port) throw new Error('not-configured');
  const headers = { ...(opts.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return fetch(`http://127.0.0.1:${port}${path}`, { ...opts, headers });
}

function parseEntryValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Strips common tracking params and a trailing slash so the same page
// saved twice (e.g. from a shared link vs. a plain visit) lands on the same
// CRDT entity instead of creating a near-duplicate.
function normalizeBookmarkUrl(raw) {
  try {
    const u = new URL(raw);
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    u.searchParams.sort();
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return raw;
  }
}

async function checkForNewLinks() {
  const { port } = await syncdConfig();
  if (!port) return;

  try {
    const res = await syncdFetch('/v1/state');
    if (!res.ok) return;
    const data = await res.json();
    const entries = data.entries || [];
    if (entries.length === 0) return;

    let newestUpdatedAt = 0;
    for (const e of entries) {
      const v = parseEntryValue(e.value);
      if (v && v.updatedAt > newestUpdatedAt) newestUpdatedAt = v.updatedAt;
    }
    if (newestUpdatedAt === 0) return;

    const { lastSeenUpdatedAt } = await chrome.storage.local.get(['lastSeenUpdatedAt']);

    if (!lastSeenUpdatedAt) {
      // First run: just store the reference, without notifying about links
      // that already existed before the extension was installed.
      await chrome.storage.local.set({ lastSeenUpdatedAt: newestUpdatedAt });
      return;
    }

    if (newestUpdatedAt <= lastSeenUpdatedAt) return; // nothing new

    const newCount = entries.filter((e) => {
      const v = parseEntryValue(e.value);
      return v && v.updatedAt > lastSeenUpdatedAt;
    }).length;
    if (newCount === 0) return;

    notifyPanelsOrBadge(newCount);
  } catch (err) {
    console.error('syncd polling failed:', err);
  }
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message: message || '',
  });
}

// ------------------------------------------------------------ mini-crawler
//
// There's no server-side crawler anymore. Client-side DOM extraction (see
// below) covers the context menu and keyboard-shortcut paths; this is the
// fallback for the side panel "+" button's known activeTab limitation, and
// for links added via right-click on a link (no DOM to read at all, since
// it's not the page you're on). Fetches the target page's own HTML and
// pulls out title/OG tags with regexes — simpler and more portable than
// relying on DOMParser inside a service worker, which isn't consistently
// available across Chrome versions.
//
// The broad host permission this needs (any http/https origin) can only be
// GRANTED via a real user gesture in a page — see the checkbox in
// options.js. chrome.permissions.request always fails with "This function
// must be called during a user gesture" when called from here, a service
// worker, so this only ever checks, never requests.
async function hasCrawlPermission() {
  return chrome.permissions.contains({ origins: ['https://*/*', 'http://*/*'] });
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractMetaFromHtml(html, baseUrl) {
  const getMeta = (prop) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
    const m = html.match(re);
    return m ? m[1].trim() : null;
  };
  const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);

  const absolutize = (u) => {
    if (!u) return null;
    try { return new URL(u, baseUrl).href; } catch { return null; }
  };

  const iconMatch = html.match(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']*)["']/i);

  return {
    title: decodeHtmlEntities(getMeta('og:title') || (titleTag ? titleTag[1].trim() : '')) || null,
    description: decodeHtmlEntities(getMeta('og:description') || getMeta('description') || getMeta('twitter:description') || '') || null,
    image: absolutize(getMeta('og:image') || getMeta('twitter:image')),
    favicon: absolutize(iconMatch ? iconMatch[1] : null),
  };
}

async function crawlPageMetadata(url) {
  const granted = await hasCrawlPermission();
  if (!granted) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const html = await res.text();
    return extractMetaFromHtml(html, url);
  } catch {
    return null;
  }
}

// ---------------------------------------------------- client-side metadata
//
// Run via chrome.scripting.executeScript in the context of the page being
// saved: it must be self-contained, it can't reference variables external
// to this file.
function extractPageMetadata() {
  const getMeta = (selector) => document.querySelector(selector)?.getAttribute('content') || null;
  const title = document.title || null;
  const description =
    getMeta('meta[name="description"]') ||
    getMeta('meta[property="og:description"]') ||
    getMeta('meta[name="twitter:description"]') ||
    null;
  const image = getMeta('meta[property="og:image"]') || getMeta('meta[name="twitter:image"]') || null;
  let favicon = null;
  const iconLink =
    document.querySelector('link[rel~="icon"]') || document.querySelector('link[rel="shortcut icon"]');
  if (iconLink) {
    try {
      favicon = new URL(iconLink.getAttribute('href'), document.baseURI).href;
    } catch {
      favicon = null;
    }
  }
  return { title, description, image, favicon };
}

// Tries to read title/description/image/favicon directly from the tab's DOM
// (client-side), instead of falling back to the mini-crawler. Requires
// "activeTab" for that tab: guaranteed for the context menu and the keyboard
// shortcut, not always for clicks inside the side panel (a known Chrome
// limitation) — in that case it fails silently and the mini-crawler picks
// up the slack.
async function tryExtractFromTab(tabId) {
  if (tabId == null) return null;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPageMetadata,
    });
    return result || null;
  } catch {
    return null;
  }
}

async function addBookmarkFromUrl(rawUrl, title, tabId) {
  const { port } = await syncdConfig();

  if (!port) {
    notify(chrome.i18n.getMessage('notifyNotConfiguredTitle'), chrome.i18n.getMessage('notifyNotConfiguredBody'));
    return false;
  }
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    notify(chrome.i18n.getMessage('notifyInvalidTitle'), chrome.i18n.getMessage('notifyInvalidBody'));
    return false;
  }

  const url = normalizeBookmarkUrl(rawUrl);
  const extracted = await tryExtractFromTab(tabId);
  const now = Date.now();

  const value = {
    url,
    title: (extracted && extracted.title) || title || url,
    description: (extracted && extracted.description) || null,
    imageUrl: (extracted && extracted.image) || null,
    favicon: (extracted && extracted.favicon) || null,
    tags: [],
    note: '',
    savedAt: now,
    updatedAt: now,
  };

  try {
    const res = await syncdFetch('/v1/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity: url, value: JSON.stringify(value) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    notify(chrome.i18n.getMessage('notifyAddedTitle'), value.title);

    if (openPanels.size > 0) {
      // The panel can draw the entry right away with real data, without
      // waiting for either the network or the mini-crawler.
      chrome.runtime.sendMessage({ type: 'syncd-optimistic-add', link: value }).catch(() => {});
    } else {
      notifyPanelsOrBadge(1);
    }

    // Thin metadata (no description AND no image): client-side extraction
    // either wasn't available for this gesture or the page itself has none
    // of these tags. Try the mini-crawler in the background and update the
    // same entity once it's done — a no-op if it can't do better.
    if (!value.description && !value.imageUrl) {
      crawlPageMetadata(url).then(async (crawled) => {
        if (!crawled || (!crawled.title && !crawled.description && !crawled.image)) return;
        const merged = {
          ...value,
          title: value.title === url ? (crawled.title || value.title) : value.title,
          description: value.description || crawled.description || null,
          imageUrl: value.imageUrl || crawled.image || null,
          favicon: value.favicon || crawled.favicon || null,
          updatedAt: Date.now(),
        };
        try {
          const r = await syncdFetch('/v1/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity: url, value: JSON.stringify(merged) }),
          });
          if (r.ok) notifyPanelsOrBadge(1);
        } catch (err) {
          console.error('Updating crawled metadata failed:', err);
        }
      });
    }

    return true;
  } catch (err) {
    console.error('Adding bookmark failed:', err);
    notify(chrome.i18n.getMessage('notifyErrorTitle'), chrome.i18n.getMessage('notifyErrorBody'));
    return false;
  }
}

async function deleteBookmark(url) {
  const { port } = await syncdConfig();
  if (!port || !url) return false;

  try {
    const res = await syncdFetch('/v1/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity: url, value: null }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  } catch (err) {
    console.error('Deleting bookmark failed:', err);
    notify(chrome.i18n.getMessage('notifyDeleteErrorTitle'), chrome.i18n.getMessage('notifyDeleteErrorBody'));
    return false;
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ADD_ID) return;
  // Client-side extraction is only possible for the page itself (context
  // "page"), not for a link found inside it (context "link"): in that case
  // we don't have the DOM of the destination page, so it always falls
  // through to the mini-crawler.
  const isPageClick = !info.linkUrl;
  const url = info.linkUrl || info.pageUrl || (tab && tab.url);
  addBookmarkFromUrl(url, tab && tab.title, isPageClick && tab ? tab.id : null);
});

// Keyboard shortcut (customizable at chrome://extensions/shortcuts) to add
// the active tab without having to open the side panel.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'add-current-tab') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) addBookmarkFromUrl(tab.url, tab.title, tab.id);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'add-bookmark') {
    // The "+" button in the side panel delegates the add here: it reuses
    // the same logic (client-side extraction + mini-crawler fallback)
    // instead of duplicating it in the panel's context.
    addBookmarkFromUrl(msg.url, msg.title, msg.tabId)
      .then((success) => sendResponse({ success }))
      .catch(() => sendResponse({ success: false }));
    return true; // async response
  }
  if (msg && msg.type === 'delete-bookmark') {
    deleteBookmark(msg.url)
      .then((success) => sendResponse({ success }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }
});
