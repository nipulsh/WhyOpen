/**
 * IntentTab — Background service worker
 * Tracks per-tab sessions and coordinates with content scripts.
 */

import {
  createSession,
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
async function maybePromptTab(tabId, url, title) {
  if (!isTrackableUrl(url)) return;
  if (activeSessions.has(tabId)) {
    await notifyTab(tabId, {
      type: 'RESTORE_SESSION',
      session: activeSessions.get(tabId),
    });
    return;
  }

  const promptKey = `${tabId}:${url}`;
  if (promptedTabs.has(promptKey)) return;
  promptedTabs.add(promptKey);

  await notifyTab(tabId, {
    type: 'SHOW_PROMPT',
    url,
    hostname: getHostname(url),
    title: title || getHostname(url),
  });
}

/** --- Tab lifecycle listeners --- */

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id && tab.url && isTrackableUrl(tab.url)) {
    await maybePromptTab(tab.id, tab.url, tab.title);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && isTrackableUrl(tab.url)) {
    if (activeSessions.has(tabId)) {
      const session = activeSessions.get(tabId);
      if (session.url !== tab.url) {
        /* Navigation within tab — update URL but keep same session */
        session.url = tab.url;
        session.hostname = getHostname(tab.url);
        session.title = tab.title || session.hostname;
        await updateSession(session.id, {
          url: tab.url,
          hostname: session.hostname,
          title: session.title,
        });
      }
      await notifyTab(tabId, {
        type: 'RESTORE_SESSION',
        session,
      });
    } else {
      promptedTabs.delete(`${tabId}:${tab.url}`);
      await maybePromptTab(tabId, tab.url, tab.title);
    }
  }
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
  if (!activeSessions.has(tabId)) return;

  await notifyTab(tabId, { type: 'SHOW_COMPLETION_CHECK', automatic: true });
});

/** --- Session helpers --- */

async function closeSessionForTab(tabId, reason = 'manual', options = {}) {
  await clearCompletionCheck(tabId);

  const session = activeSessions.get(tabId);
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
        if (tabId && activeSessions.has(tabId)) {
          sendResponse({ hasSession: true, session: activeSessions.get(tabId) });
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
        if (tabId && activeSessions.has(tabId)) {
          await scheduleCompletionCheck(tabId);
        }
        sendResponse({ ok: true });
        break;
      }

      case 'UPDATE_DURATION': {
        const session = activeSessions.get(tabId);
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
