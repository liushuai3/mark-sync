// MarkSync v3.0 background service worker
//
// Responsibilities (SRS §6.2 / FR-2 / FR-3 / FR-11):
//   1. Schedule bidirectional sync every 5 minutes via chrome.alarms
//      (±30 s jitter, no local bookmark event listeners).
//   2. Route popup messages (SYNC_NOW / FORCE_UPLOAD / INITIAL_MERGE /
//      GET_STATE).
//   3. Drive the toolbar badge for user-visible sync status.
//
// v2 legacy that was removed here on purpose:
//   - chrome.bookmarks.onCreated / onChanged / onMoved / onRemoved
//     listeners with a 3 s debounce (SRS §9.2 forbids these; the cloud
//     is now the source of truth and reconciliation runs on a timer).
//   - The recursive setTimeout(periodicSync, 30 min) loop.

import * as IdMapStore from '../utils/idMapStore.js';
import * as SyncState from '../utils/syncState.js';
import { initialMerge } from '../utils/initialMerge.js';
import { syncCycle } from '../utils/syncCycle.js';
import {
  flattenLocalTree,
  getBookmarkTree,
  callApi,
  discoverRoots,
} from '../utils/bookmarkHelpers.js';
import { uuid } from '../utils/uuid.js';

// ─── Constants ─────────────────────────────────────────────────────────
const ALARM_NAME = 'marksync-sync';
const PERIOD_MINUTES = 5; // FR-2.1
const JITTER_MS = 30_000; // FR-2.3  (±30 s)
const BADGE_CLEAR_MS = 2500; // FR-11.2

// ─── Config ────────────────────────────────────────────────────────────
// Keys are the v2 keys used by popup/options.js (`marksync_api_url`,
// `marksync_token`) in chrome.storage.sync — do NOT invent new keys.
async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ['marksync_api_url', 'marksync_token'],
      (state) => {
        resolve({
          apiUrl: (state && state.marksync_api_url) || '',
          token: (state && state.marksync_token) || '',
        });
      }
    );
  });
}

// ─── Badge helper (FR-11) ──────────────────────────────────────────────
let badgeClearTimer = null;

function clearBadgeNow() {
  try {
    chrome.action.setBadgeText({ text: '' });
  } catch (err) {
    /* action API not available in some hosts */
  }
}

function scheduleBadgeClear() {
  if (badgeClearTimer) clearTimeout(badgeClearTimer);
  badgeClearTimer = setTimeout(() => {
    badgeClearTimer = null;
    clearBadgeNow();
  }, BADGE_CLEAR_MS);
}

/**
 * @param {'syncing'|'success'|'no-op'|'error'} kind
 * @param {number} [count]  Only meaningful for `success`.
 */
function setBadge(kind, count) {
  if (badgeClearTimer) {
    clearTimeout(badgeClearTimer);
    badgeClearTimer = null;
  }
  try {
    switch (kind) {
      case 'syncing':
        chrome.action.setBadgeBackgroundColor({ color: '#2196F3' });
        chrome.action.setBadgeText({ text: '⋯' });
        break;
      case 'success':
        if (!count || count <= 0) {
          clearBadgeNow();
          return;
        }
        chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });
        chrome.action.setBadgeText({ text: '✓' });
        scheduleBadgeClear();
        break;
      case 'no-op':
        // FR-11.3 — do not flash when nothing changed.
        clearBadgeNow();
        break;
      case 'error':
        chrome.action.setBadgeBackgroundColor({ color: '#F44336' });
        chrome.action.setBadgeText({ text: '!' });
        scheduleBadgeClear();
        break;
      default:
        clearBadgeNow();
    }
  } catch (err) {
    console.warn('[MarkSync/background] badge update failed', err);
  }
}

// ─── syncCycle wrapper ────────────────────────────────────────────────
async function runSyncCycle({ manual = false } = {}) {
  const { apiUrl, token } = await getConfig();
  if (!apiUrl || !token) {
    console.log('[MarkSync/background] no config; sync skipped');
    return { ok: false, skipped: true, reason: 'no_config' };
  }

  setBadge('syncing');
  try {
    const res = await syncCycle({ apiUrl, token, manual });

    // If the initial merge has never run on this device (fresh install, or
    // syncState got wiped), transparently fall through to initialMerge so the
    // user's "立即同步" click actually reconciles data instead of returning
    // an empty no-op. Subsequent runs go straight through syncCycle.
    if (res && res.skipped && res.reason === 'needs_initial_merge') {
      console.log('[MarkSync/background] first run on this device – running initialMerge');
      const im = await initialMerge({ apiUrl, token });
      if (im && im.ok) {
        const changed = (im.added || 0) + (im.remotePulled || 0);
        if (changed > 0) setBadge('success', changed);
        else setBadge('no-op');
        return {
          ok: true,
          added: im.added || 0,
          modified: 0,
          removed: 0,
          remoteApplied: im.remotePulled || 0,
          conflicts: 0,
          initialMerge: true,
          matched: im.matched || 0,
        };
      }
      setBadge(im && im.skipped ? 'no-op' : 'error');
      return im || { ok: false, error: 'initial merge failed' };
    }

    if (!res || !res.ok) {
      if (res && res.skipped) {
        setBadge('no-op');
      } else {
        setBadge('error');
      }
      return res;
    }
    const changed =
      (res.added || 0) +
      (res.modified || 0) +
      (res.removed || 0) +
      (res.remoteApplied || 0);
    if (changed > 0) setBadge('success', changed);
    else setBadge('no-op');
    return res;
  } catch (err) {
    console.error('[MarkSync/background] runSyncCycle failed', err);
    setBadge('error');
    return { ok: false, error: String((err && err.message) || err) };
  }
}

async function scheduledRun() {
  // FR-2.3 — ±30 s jitter around the alarm tick.
  const jitter = Math.random() * (2 * JITTER_MS) - JITTER_MS;
  const delay = Math.max(0, jitter);
  setTimeout(() => {
    runSyncCycle({ manual: false }).catch((err) => {
      console.error('[MarkSync/background] scheduledRun error', err);
    });
  }, delay);
}

// ─── forceUpload (SRS §6.3) ───────────────────────────────────────────
async function forceUpload() {
  const { apiUrl, token } = await getConfig();
  if (!apiUrl || !token) {
    return { ok: false, error: 'not configured' };
  }

  setBadge('syncing');
  try {
    // 1. Flatten the current local tree (folders + urls).
    const tree = await getBookmarkTree();
    discoverRoots(tree);
    const localNodes = flattenLocalTree(tree);

    // 2. Give every node an id. Reuse existing cloud_id from the idMap
    //    when we already know it, otherwise mint a fresh uuid so the
    //    server sees stable identifiers.
    const chromeIdToNewId = new Map();
    for (const n of localNodes) {
      const existing = await IdMapStore.getByChromeId(n.chrome_id);
      const id = (existing && existing.cloud_id) || uuid();
      chromeIdToNewId.set(n.chrome_id, id);
    }

    // 3. Build POST /sync/force payload.
    const bookmarks = localNodes.map((n) => ({
      id: chromeIdToNewId.get(n.chrome_id),
      type: n.type,
      parent_id: n.parent_chrome_id
        ? chromeIdToNewId.get(n.parent_chrome_id) || null
        : null,
      root: n.root,
      name: n.name,
      url: n.url,
      position: n.position,
      date_added: n.date_added,
      date_modified: n.date_modified,
    }));

    const data = await callApi(apiUrl, token, '/sync/force', {
      method: 'POST',
      body: { bookmarks },
    });
    const serverTime = Number(data && data.server_time) || Date.now();

    // 4. Rebuild the idMap from the freshly-uploaded state.
    await IdMapStore.clear();
    for (const n of localNodes) {
      const id = chromeIdToNewId.get(n.chrome_id);
      await IdMapStore.set(id, {
        chrome_id: n.chrome_id,
        type: n.type,
        root: n.root,
        name: n.name,
        url: n.url,
        parent_id: n.parent_chrome_id
          ? chromeIdToNewId.get(n.parent_chrome_id) || null
          : null,
        position: n.position,
        date_modified: n.date_modified,
        synced_at: serverTime,
      });
    }
    await IdMapStore.save();

    // 5. Reset sync state, then mark initial merge done at server_time.
    await SyncState.reset();
    await SyncState.update({
      initial_merge_done: true,
      last_pulled_at: serverTime,
      last_sync_at: Date.now(),
      last_conflicts: 0,
      last_error: null,
    });

    setBadge('success', bookmarks.length);
    return { ok: true, total: bookmarks.length, server_time: serverTime };
  } catch (err) {
    console.error('[MarkSync/background] forceUpload failed', err);
    setBadge('error');
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ─── Alarm wiring ─────────────────────────────────────────────────────
function ensureAlarm() {
  try {
    chrome.alarms.get(ALARM_NAME, (existing) => {
      if (!existing) {
        chrome.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MINUTES });
        console.log(
          `[MarkSync/background] alarm '${ALARM_NAME}' created (period=${PERIOD_MINUTES}min)`
        );
      }
    });
  } catch (err) {
    console.error('[MarkSync/background] ensureAlarm failed', err);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === ALARM_NAME) {
    scheduledRun();
  }
});

// First-time install / update — arm the alarm and run once immediately.
chrome.runtime.onInstalled.addListener((details) => {
  ensureAlarm();
  console.log(
    `[MarkSync/background] onInstalled reason=${details && details.reason}`
  );
  scheduledRun();
});

// Cold browser restart.
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
});

// Service-worker wake — make sure the alarm still exists.
ensureAlarm();

// ─── Message router (FR-3) ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    try {
      if (!request || typeof request !== 'object' || !request.type) {
        sendResponse({ ok: false, error: 'invalid request' });
        return;
      }

      switch (request.type) {
        case 'SYNC_NOW': {
          const res = await runSyncCycle({ manual: true });
          sendResponse(res);
          break;
        }

        case 'FORCE_UPLOAD': {
          const res = await forceUpload();
          sendResponse(res);
          break;
        }

        case 'INITIAL_MERGE': {
          const { apiUrl, token } = await getConfig();
          if (!apiUrl || !token) {
            sendResponse({ ok: false, error: 'not configured' });
            break;
          }
          setBadge('syncing');
          const res = await initialMerge({ apiUrl, token });
          if (!res || !res.ok) {
            setBadge(res && res.skipped ? 'no-op' : 'error');
          } else {
            const changed = (res.added || 0) + (res.remotePulled || 0);
            if (changed > 0) setBadge('success', changed);
            else setBadge('no-op');
          }
          sendResponse(res);
          break;
        }

        case 'GET_STATE': {
          const state = await SyncState.get();
          const size = await IdMapStore.size();
          // Count actual local bookmarks from the Chrome tree (not idMap entries),
          // so deleting a bookmark in Chrome is reflected immediately.
          let localCount = 0;
          try {
            const tree = await getBookmarkTree();
            discoverRoots(tree);
            const localNodes = flattenLocalTree(tree);
            localCount = localNodes.length;
          } catch {
            localCount = size; // fallback to idMap count
          }
          // Also fetch the username from the API for displaying in the popup.
          let username = null;
          let remoteCount = null;
          try {
            const { apiUrl, token } = await getConfig();
            if (apiUrl && token) {
              // Fetch username
              const r = await fetch(apiUrl + '/auth/me', {
                headers: { Authorization: 'Bearer ' + token },
              });
              if (r.ok) {
                const j = await r.json();
                username = (j.data && (j.data.username || j.data.email)) || (j.username || j.email) || null;
              }
              // Fetch remote bookmark count via callApi (handles envelope + auth)
              try {
                const pullData = await callApi(apiUrl, token, '/sync/pull');
                const cloud = Array.isArray(pullData?.bookmarks) ? pullData.bookmarks : [];
                remoteCount = cloud.filter((b) => b.deleted_at == null).length;
              } catch (pullErr) {
                console.warn('[background] remote count fetch failed:', pullErr.message);
              }
            }
          } catch (err) {
            console.warn('[background] GET_STATE fetch failed:', err && err.message || err);
          }
          sendResponse({ ok: true, state, idMapSize: localCount, username, remoteCount });
          break;
        }

        // Legacy no-op kept so v2 popup builds don't error out mid-upgrade.
        case 'authenticate': {
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({
            ok: false,
            error: `unknown message type: ${request.type}`,
          });
      }
    } catch (err) {
      console.error('[MarkSync/background] onMessage failed', err);
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    }
  })();
  // Return true to keep the message channel open for the async response.
  return true;
});
