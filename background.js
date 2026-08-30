const ALARM_NAME = 'karakeep-poll';
const POLL_MINUTES = 1; // the minimum allowed by chrome.alarms is 1 minute
const CONTEXT_MENU_ADD_ID = 'add-to-reading-list';
const CRAWL_DONE_STATUSES = ['success', 'failure'];

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
  if (area === 'local' && (changes.baseUrl || changes.apiKey)) {
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
    chrome.runtime.sendMessage({ type: 'karakeep-new-links', count }).catch(() => {});
  } else {
    chrome.action.setBadgeText({ text: String(Math.min(count, 99)) });
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  }
}

async function checkForNewLinks() {
  const { baseUrl, apiKey, lastSeenCreatedAt } = await chrome.storage.local.get([
    'baseUrl',
    'apiKey',
    'lastSeenCreatedAt',
  ]);
  if (!baseUrl || !apiKey) return;

  try {
    const url = new URL(baseUrl + '/api/v1/bookmarks');
    url.searchParams.set('limit', '10');
    url.searchParams.set('archived', 'false');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (!res.ok) return;

    const data = await res.json();
    const bookmarks = data.bookmarks || [];
    if (bookmarks.length === 0) return;

    const newestCreatedAt = bookmarks[0].createdAt;

    if (!lastSeenCreatedAt) {
      // First run: just store the reference, without notifying about links
      // that already existed before the extension was installed.
      await chrome.storage.local.set({ lastSeenCreatedAt: newestCreatedAt });
      return;
    }

    if (newestCreatedAt <= lastSeenCreatedAt) return; // nothing new

    const newCount = bookmarks.filter((b) => b.createdAt > lastSeenCreatedAt).length;
    if (newCount === 0) return;

    notifyPanelsOrBadge(newCount);
  } catch (err) {
    console.error('Karakeep polling failed:', err);
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

// Karakeep creates the bookmark right away but downloads title/image/
// description asynchronously (crawler). This function polls the single
// bookmark until crawling is finished (or the max time expires), so we can
// reload the list a second time once the "official" metadata is ready
// (which at that point replaces the client-side extracted data, if used).
async function pollUntilCrawled(baseUrl, apiKey, bookmarkId, { attempts = 8, delayMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      const res = await fetch(`${baseUrl}/api/v1/bookmarks/${bookmarkId}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const status = data?.content?.crawlStatus;
      if (status && CRAWL_DONE_STATUSES.includes(status)) return data;
    } catch {
      // retry on the next iteration
    }
  }
  return null;
}

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
// (client-side), instead of waiting for Karakeep's crawler. Requires
// "activeTab" for that tab: guaranteed for the context menu and the keyboard
// shortcut, not always for clicks inside the side panel (a known Chrome
// limitation) — in that case it fails silently and falls back to
// server-side crawling only, with no visible error for the user.
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

async function addBookmarkFromUrl(url, title, tabId) {
  const { baseUrl, apiKey } = await chrome.storage.local.get(['baseUrl', 'apiKey']);

  if (!baseUrl || !apiKey) {
    notify(chrome.i18n.getMessage('notifyNotConfiguredTitle'), chrome.i18n.getMessage('notifyNotConfiguredBody'));
    return false;
  }
  if (!url || !/^https?:\/\//i.test(url)) {
    notify(chrome.i18n.getMessage('notifyInvalidTitle'), chrome.i18n.getMessage('notifyInvalidBody'));
    return false;
  }

  const extracted = await tryExtractFromTab(tabId);

  try {
    const res = await fetch(`${baseUrl}/api/v1/bookmarks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        type: 'link',
        url,
        ...(extracted && extracted.title ? { title: extracted.title } : {}),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const created = await res.json();

    const displayTitle = (extracted && extracted.title) || title || url;
    notify(chrome.i18n.getMessage('notifyAddedTitle'), displayTitle);

    if (extracted && openPanels.size > 0) {
      // The panel can draw the entry right away with real data, without
      // waiting for either the server or a full reload.
      chrome.runtime
        .sendMessage({
          type: 'karakeep-optimistic-add',
          link: {
            url,
            title: displayTitle,
            description: extracted.description || null,
            imageUrl: extracted.image || null,
            favicon: extracted.favicon || null,
          },
        })
        .catch(() => {});
    } else {
      notifyPanelsOrBadge(1);
    }

    const bookmarkId = created?.id;
    const status = created?.content?.crawlStatus;
    const alreadyDone = status && CRAWL_DONE_STATUSES.includes(status);

    if (bookmarkId && !alreadyDone) {
      // Karakeep's crawler keeps running in the background regardless: when
      // it finishes, a "real" reload replaces the provisional entry with the
      // official one (useful even if client-side extraction had failed).
      pollUntilCrawled(baseUrl, apiKey, bookmarkId).then((finalData) => {
        if (finalData) notifyPanelsOrBadge(1);
      });
    }

    return true;
  } catch (err) {
    console.error('Adding bookmark failed:', err);
    notify(chrome.i18n.getMessage('notifyErrorTitle'), chrome.i18n.getMessage('notifyErrorBody'));
    return false;
  }
}

async function deleteBookmark(bookmarkId) {
  const { baseUrl, apiKey } = await chrome.storage.local.get(['baseUrl', 'apiKey']);
  if (!baseUrl || !apiKey || !bookmarkId) return false;

  try {
    const res = await fetch(`${baseUrl}/api/v1/bookmarks/${bookmarkId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
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
  // we don't have the DOM of the destination page.
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
    // the same logic (client-side extraction + fallback polling) instead of
    // duplicating it in the panel's context.
    addBookmarkFromUrl(msg.url, msg.title, msg.tabId)
      .then((success) => sendResponse({ success }))
      .catch(() => sendResponse({ success: false }));
    return true; // async response
  }
  if (msg && msg.type === 'delete-bookmark') {
    deleteBookmark(msg.id)
      .then((success) => sendResponse({ success }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }
});
