/**
 * IntentTab — Background service worker
 * Tracks per-tab sessions and coordinates with content scripts.
 */

import {
  createSession,
  getOpenSessionByTabId,
  updateSession,
} from './db.js';

/** @type {Map<number, { id: number, tabId: number, url: string, hostname: string, title: string, reason: string, openedAt: number }>} */
const activeSessions = new Map();

/** Tabs that already received (or skipped) the intent prompt this navigation cycle */
const promptedTabs = new Set();

/** How often to auto-prompt for completion (30 minutes) */
const COMPLETION_CHECK_MS = 30 * 60 * 1000;

function completionAlarmName(tabId) {
  return `intenttab-completion-${tabId}`;
}

async function scheduleCompletionCheck(tabId, delayMs = COMPLETION_CHECK_MS) {
  await chrome.alarms.create(completionAlarmName(tabId), {
    when: Date.now() + delayMs,
  });
}

async function clearCompletionCheck(tabId) {
  await chrome.alarms.clear(completionAlarmName(tabId));
}

function sessionFromRecord(record) {
  return {
    id: record.id,
    tabId: record.tabId,
    url: record.url,
    hostname: record.hostname,
    title: record.title,
    reason: record.reason,
    openedAt: record.openedAt,
  };
}

/** Restore in-memory session from IndexedDB (survives tab reload / service worker restart) */
async function getOrRestoreSession(tabId) {
  if (activeSessions.has(tabId)) {
    return activeSessions.get(tabId);
  }

  const record = await getOpenSessionByTabId(tabId);
  if (!record) return null;

  const session = sessionFromRecord(record);
  activeSessions.set(tabId, session);
  return session;
}

/**
 * Extract a readable hostname from a URL string.
 */
function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

/**
 * Whether the URL should trigger IntentTab (http/https only).
 */
function isTrackableUrl(url) {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

/**
 * Inject content script if not already present (fallback for dynamic loads).
 */
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch {
    /* Content script may already be injected or tab unavailable */
  }
}

/**
 * Tell the content script to show the intent prompt or restore the sticky bar.
 */
async function notifyTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await ensureContentScript(tabId);
    try {
      await chrome.tabs.sendMessage(tabId, message);
    } catch {
      /* Tab may not be ready yet */
    }
  }
}

/**
 * Begin intent flow for a tab if no active session exists.
 */
async function promptForIntention(tabId, url, title) {
  if (!isTrackableUrl(url)) return;

  const hostname = getHostname(url);
  const promptKey = `${tabId}:${hostname}`;

  if (promptedTabs.has(promptKey)) return;
  promptedTabs.add(promptKey);

  await notifyTab(tabId, {
    type: 'SHOW_PROMPT',
    url,
    hostname,
    title: title || hostname,
  });
}

/**
 * Handle tab navigation: prompt on new sites, keep session on reload / same-site routes.
 */
async function handleTabNavigation(tabId, tab) {
  const url = tab.url;
  if (!isTrackableUrl(url)) return;

  const hostname = getHostname(url);
  const session = await getOrRestoreSession(tabId);

  if (session) {
    const sessionHost = session.hostname || getHostname(session.url);

    if (hostname !== sessionHost) {
      /* Different website — end previous session and ask for a new intention */
      await closeSessionForTab(tabId, 'site_change');
      await promptForIntention(tabId, url, tab.title);
      return;
    }

    /* Same site — reload or route change, keep existing intention */
    if (session.url !== url || session.title !== tab.title) {
      session.url = url;
      session.hostname = hostname;
      session.title = tab.title || hostname;
      await updateSession(session.id, {
        url,
        hostname,
        title: session.title,
      });
    }

    await notifyTab(tabId, {
      type: 'RESTORE_SESSION',
      session,
    });
    return;
  }

  await promptForIntention(tabId, url, tab.title);
}

/** --- Tab lifecycle listeners --- */

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id && tab.url && isTrackableUrl(tab.url)) {
    await handleTabNavigation(tab.id, tab);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.url || !isTrackableUrl(tab.url)) return;

  /* Full page load, reload, or SPA route change (history.pushState) */
  const shouldHandle =
    changeInfo.status === 'complete' || Boolean(changeInfo.url);

  if (!shouldHandle) return;

  await handleTabNavigation(tabId, tab);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await clearCompletionCheck(tabId);
  await closeSessionForTab(tabId, 'tab_closed');
  promptedTabs.forEach((key) => {
    if (key.startsWith(`${tabId}:`)) promptedTabs.delete(key);
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('intenttab-completion-')) return;

  const tabId = Number(alarm.name.replace('intenttab-completion-', ''));
  const session = await getOrRestoreSession(tabId);
  if (!session) return;

  await notifyTab(tabId, { type: 'SHOW_COMPLETION_CHECK', automatic: true });
});

/** --- Session helpers --- */

async function closeSessionForTab(tabId, reason = 'manual', options = {}) {
  await clearCompletionCheck(tabId);

  let session = activeSessions.get(tabId);
  if (!session) {
    const record = await getOpenSessionByTabId(tabId);
    if (record) session = sessionFromRecord(record);
  }
  if (!session) return null;

  const closedAt = Date.now();
  const duration = Math.floor((closedAt - session.openedAt) / 1000);
  const updates = { closedAt, duration };

  if (options.completed != null) {
    updates.completed = options.completed;
  }

  await updateSession(session.id, updates);

  activeSessions.delete(tabId);

  promptedTabs.forEach((key) => {
    if (key.startsWith(`${tabId}:`)) promptedTabs.delete(key);
  });

  try {
    await notifyTab(tabId, { type: 'SESSION_CLOSED', reason });
  } catch {
    /* Tab may already be gone */
  }

  return { ...session, closedAt, duration };
}

/** --- Message handling --- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? message.tabId;

  (async () => {
    switch (message.type) {
      case 'GET_TAB_STATE': {
        const session = tabId ? await getOrRestoreSession(tabId) : null;
        if (session) {
          sendResponse({ hasSession: true, session });
        } else {
          sendResponse({ hasSession: false });
        }
        break;
      }

      case 'SUBMIT_REASON': {
        if (!tabId) {
          sendResponse({ ok: false, error: 'No tab ID' });
          break;
        }

        const { reason, url, hostname, title } = message;
        const openedAt = Date.now();

        const record = await createSession({
          tabId,
          url,
          hostname,
          title,
          reason,
          openedAt,
        });

        const session = {
          id: record.id,
          tabId,
          url,
          hostname,
          title,
          reason,
          openedAt,
        };

        activeSessions.set(tabId, session);
        await scheduleCompletionCheck(tabId);
        sendResponse({ ok: true, session });
        break;
      }

      case 'COMPLETION_DISMISSED': {
        if (tabId && (await getOrRestoreSession(tabId))) {
          await scheduleCompletionCheck(tabId);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'UPDATE_DURATION': {
        const session = await getOrRestoreSession(tabId);
        if (session && message.duration != null) {
          await updateSession(session.id, { duration: message.duration });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'CLOSE_SESSION': {
        const result = await closeSessionForTab(tabId, 'manual', {
          completed: message.completed,
        });

        if (message.closeTab && tabId) {
          try {
            await chrome.tabs.remove(tabId);
          } catch {
            /* Tab may already be closed */
          }
        }

        sendResponse({ ok: true, session: result });
        break;
      }

      case 'GET_ACTIVE_COUNT': {
        sendResponse({ count: activeSessions.size });
        break;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })();

  return true;
});
