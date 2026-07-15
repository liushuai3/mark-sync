/**
 * @file initialMerge.js
 * @description First-install merge flow (SRS-v3.0 §6.1). Performs a one-time
 *   reconciliation between the local Chrome bookmark tree and the MarkSync
 *   cloud state.
 *
 * Pipeline:
 *   1. GET /api/sync/pull (no since) → cloudList (includes tombstones).
 *   2. Walk chrome.bookmarks.getTree() → localList of nodes annotated with
 *      { chrome_id, type, root, parent_chrome_id, name, url, position,
 *        date_added, date_modified, parent_path }.
 *   3. Determine root by walking up to a top-level Chrome node (id "1"/"2"/"3").
 *   4. Dedupe key = (root, parent_path, name, url ?? ''). Matching cloud rows
 *      populate idMap; unmatched local rows are pushed as new uploads.
 *   5. Cloud rows that failed to match locally are created into Chrome in
 *      topological order (parent → child), folders before urls, sorted by
 *      cloud `position`. Tombstoned cloud rows are skipped entirely.
 *   6. POST /api/sync/push { added: toPush, modified: [], removed: [] }.
 *   7. Persist idMap and mark syncState.initial_merge_done = true, alongside
 *      last_pulled_at = server_time.
 *
 * ⚠ Local-duplicate policy (SRS §FR-1.6):
 *   When the local tree already contains multiple bookmarks that collide on
 *   (root, parent_path, name, url), we do NOT delete the extras – that would
 *   be destructive with no undo. Instead, only the first occurrence is
 *   bound to the matching (or newly generated) cloud id; subsequent
 *   duplicates are logged and ignored. A future sync-cycle task may fold
 *   the duplicates once the user opts in.
 *
 * Concurrency:
 *   A single-flight guard on `globalThis.__marksyncSyncing` prevents the
 *   merge from overlapping with any sync-cycle run. On any exit path the
 *   flag is cleared via try/finally.
 *
 * @see SRS-v3.0 §6.1 – initial merge
 */

import * as IdMapStore from './idMapStore.js';
import * as SyncState from './syncState.js';
import { uuid } from './uuid.js';

const CHROME_ROOT_TO_KEY = {
  '1': 'bookmark_bar',
  '2': 'other',
  '3': 'mobile',
};

/**
 * @typedef {'bookmark_bar'|'other'|'mobile'} RootKey
 * @typedef {{
 *   chrome_id: string,
 *   type: 'folder'|'url',
 *   root: RootKey,
 *   parent_chrome_id: string | null,
 *   name: string,
 *   url: string | null,
 *   position: number,
 *   date_added: number | null,
 *   date_modified: number | null,
 *   parent_path: string,
 * }} LocalNode
 */

/**
 * Fetch helper: talks to the MarkSync API with the standard bearer header.
 * @param {string} apiUrl
 * @param {string} token
 * @param {string} path
 * @param {{method?: string, body?: any}} [opts]
 * @returns {Promise<any>} The `data` field from `{ok:true,data:...}`.
 */
async function callApi(apiUrl, token, path, opts = {}) {
  const base = (apiUrl || '').replace(/\/$/, '');
  const res = await fetch(base + path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}`);
  }
  if (!json.ok) {
    const msg = json.error || json.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = json.code;
    err.status = res.status;
    throw err;
  }
  return json.data;
}

/**
 * Promisified `chrome.bookmarks.getTree`.
 * @returns {Promise<chrome.bookmarks.BookmarkTreeNode[]>}
 */
function getBookmarkTree() {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getTree((tree) => {
      const err = chrome.runtime && chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(tree || []);
    });
  });
}

/**
 * Promisified `chrome.bookmarks.create`.
 * @param {{parentId: string, index?: number, title?: string, url?: string}} arg
 * @returns {Promise<chrome.bookmarks.BookmarkTreeNode>}
 */
function createBookmark(arg) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.create(arg, (node) => {
      const err = chrome.runtime && chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(node);
    });
  });
}

/**
 * Walk the Chrome tree and yield flat LocalNode records for every user
 * bookmark/folder. Root-level Chrome nodes (id "0"/"1"/"2"/"3") are not
 * emitted themselves – they exist implicitly via their `root` label.
 *
 * @param {chrome.bookmarks.BookmarkTreeNode[]} tree
 * @returns {LocalNode[]}
 */
function flattenLocalTree(tree) {
  /** @type {LocalNode[]} */
  const out = [];

  /**
   * @param {chrome.bookmarks.BookmarkTreeNode} node
   * @param {RootKey | null} root
   * @param {string} parentPath  '' at root level
   * @param {string | null} parentChromeId  null for immediate children of root folders
   */
  function walk(node, root, parentPath, parentChromeId) {
    if (!node) return;
    const chromeId = String(node.id);

    // Node itself is a root sentinel — descend without emitting.
    if (CHROME_ROOT_TO_KEY[chromeId]) {
      const rootKey = CHROME_ROOT_TO_KEY[chromeId];
      for (const child of node.children || []) {
        walk(child, rootKey, '', null);
      }
      return;
    }
    // Chrome's synthetic "0" super-root: just descend.
    if (chromeId === '0') {
      for (const child of node.children || []) walk(child, null, '', null);
      return;
    }
    if (!root) return; // Defensive: unknown root

    const isFolder = !node.url;
    /** @type {LocalNode} */
    const rec = {
      chrome_id: chromeId,
      type: isFolder ? 'folder' : 'url',
      root,
      parent_chrome_id: parentChromeId,
      name: node.title || '',
      url: node.url || null,
      position: typeof node.index === 'number' ? node.index : 0,
      date_added: node.dateAdded ?? null,
      date_modified: node.dateGroupModified ?? node.dateAdded ?? null,
      parent_path: parentPath,
    };
    out.push(rec);

    if (isFolder && node.children) {
      const childParentPath = parentPath ? `${parentPath}/${rec.name}` : rec.name;
      for (const child of node.children) {
        walk(child, root, childParentPath, chromeId);
      }
    }
  }

  for (const top of tree) walk(top, null, '', null);
  return out;
}

/**
 * Build (root, parent_path, name, url) dedupe key for both cloud and local rows.
 * @param {string} root
 * @param {string} parentPath
 * @param {string} name
 * @param {string | null | undefined} url
 * @returns {string}
 */
function dedupeKey(root, parentPath, name, url) {
  return `${root}\u0000${parentPath}\u0000${name}\u0000${url || ''}`;
}

/**
 * Compute parent_path for each cloud bookmark by walking parent_id chains.
 * Cloud bookmarks are keyed by id.
 *
 * @param {Array<object>} cloudList
 * @returns {Map<string, string>} cloud_id -> parent_path (excluding self)
 */
function computeCloudPaths(cloudList) {
  const byId = new Map(cloudList.map((b) => [b.id, b]));
  const pathCache = new Map();

  /** @param {string | null} id */
  function pathOf(id) {
    if (!id) return '';
    if (pathCache.has(id)) return pathCache.get(id);
    const b = byId.get(id);
    if (!b) return '';
    const above = pathOf(b.parent_id);
    const p = above ? `${above}/${b.name}` : b.name;
    pathCache.set(id, p);
    return p;
  }

  const result = new Map();
  for (const b of cloudList) {
    result.set(b.id, pathOf(b.parent_id));
  }
  return result;
}

/**
 * Topologically sort cloud rows to create (parent first, folders before urls,
 * `position` ascending within a sibling group).
 * @param {Array<object>} rows
 * @returns {Array<object>}
 */
function topoSortForCreate(rows) {
  const remaining = new Map(rows.map((r) => [r.id, r]));
  const done = new Set();
  const out = [];
  const guardMax = rows.length + 8;
  let guard = 0;

  while (remaining.size && guard++ < guardMax) {
    /** @type {object[]} */
    const ready = [];
    for (const r of remaining.values()) {
      if (r.parent_id == null || done.has(r.parent_id) || !remaining.has(r.parent_id)) {
        ready.push(r);
      }
    }
    if (!ready.length) break; // cycle / dangling parent
    ready.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return (a.position ?? 0) - (b.position ?? 0);
    });
    for (const r of ready) {
      out.push(r);
      done.add(r.id);
      remaining.delete(r.id);
    }
  }
  // Append any leftovers (best-effort) so nothing is silently dropped.
  for (const r of remaining.values()) out.push(r);
  return out;
}

/**
 * First-install merge between local Chrome bookmarks and MarkSync cloud state.
 *
 * @param {object} opts
 * @param {string} opts.apiUrl  e.g. `https://marksync.zcoolq.cn/api`
 * @param {string} opts.token   MarkSync API token (`mks_...`)
 * @returns {Promise<{ok: boolean, added?: number, matched?: number, remotePulled?: number, error?: string, skipped?: boolean}>}
 */
export async function initialMerge({ apiUrl, token }) {
  if (globalThis.__marksyncSyncing) {
    console.log('[MarkSync/initialMerge] skipped – another sync is running');
    return { ok: false, skipped: true };
  }
  globalThis.__marksyncSyncing = true;

  try {
    if (!apiUrl || !token) {
      return { ok: false, error: 'apiUrl and token are required' };
    }

    // Step 1 — pull full remote state.
    console.log('[MarkSync/initialMerge] step1: GET /sync/pull (full)');
    const pullData = await callApi(apiUrl, token, '/sync/pull');
    const cloudList = Array.isArray(pullData?.bookmarks) ? pullData.bookmarks : [];
    const serverTime = Number(pullData?.server_time) || Date.now();

    // Step 2 — flatten local tree.
    console.log('[MarkSync/initialMerge] step2: read chrome.bookmarks.getTree');
    const tree = await getBookmarkTree();
    const localList = flattenLocalTree(tree);
    console.log(
      `[MarkSync/initialMerge] local=${localList.length} cloud=${cloudList.length}`
    );

    // Step 3 & 4 — index by dedupe key and match.
    const cloudPaths = computeCloudPaths(cloudList);

    /** @type {Map<string, object>} key -> cloud row (only live rows are indexable) */
    const cloudByKey = new Map();
    for (const c of cloudList) {
      if (c.deleted_at != null) continue; // tombstones don't participate in dedupe
      const key = dedupeKey(c.root, cloudPaths.get(c.id) || '', c.name, c.url);
      if (!cloudByKey.has(key)) cloudByKey.set(key, c);
    }

    /** @type {Map<string, string>} chrome_id -> cloud_id (chosen match) */
    const chromeToCloud = new Map();
    /** @type {Set<string>} matched cloud ids */
    const matchedCloudIds = new Set();
    /** @type {LocalNode[]} local rows to push as `added` */
    const localToPush = [];
    /** @type {Map<string, string>} chrome_id -> assigned cloud_id (for both matched + newly-generated) */
    const chromeIdToAssignedCloudId = new Map();
    /** @type {Set<string>} dedupe keys already claimed locally */
    const localSeenKeys = new Set();
    let duplicateLocal = 0;

    // Local order is a BFS-friendly pre-order flatten – walk by root then depth-first.
    // Sort to keep folders before urls at same parent so parents get cloud ids first.
    const localOrdered = [...localList].sort((a, b) => {
      if (a.parent_chrome_id === b.parent_chrome_id) {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.position - b.position;
      }
      return 0;
    });

    for (const l of localOrdered) {
      const key = dedupeKey(l.root, l.parent_path, l.name, l.url);
      if (localSeenKeys.has(key)) {
        duplicateLocal++;
        // Bind duplicate to same cloud id if the primary has one (do NOT delete locally).
        continue;
      }
      localSeenKeys.add(key);

      const cloud = cloudByKey.get(key);
      if (cloud && !matchedCloudIds.has(cloud.id)) {
        matchedCloudIds.add(cloud.id);
        chromeToCloud.set(l.chrome_id, cloud.id);
        chromeIdToAssignedCloudId.set(l.chrome_id, cloud.id);
        await IdMapStore.set(cloud.id, {
          chrome_id: l.chrome_id,
          parent_cloud_id: cloud.parent_id || null,
          name: l.name,
          url: l.url,
          type: l.type,
          root: l.root,
          position: l.position,
          date_modified: l.date_modified || 0,
          synced_at: serverTime,
        });
      } else {
        // Local has no cloud counterpart → new cloud id, will be pushed.
        const newId = uuid();
        chromeIdToAssignedCloudId.set(l.chrome_id, newId);
        localToPush.push({ node: l, cloudId: newId });
      }
    }

    // Resolve parent_cloud_id for freshly-generated ids (parents processed first).
    /** @type {object[]} push payload rows */
    const pushAdded = [];
    for (const { node, cloudId } of localToPush) {
      const parentCloudId = node.parent_chrome_id
        ? chromeIdToAssignedCloudId.get(node.parent_chrome_id) || null
        : null;
      pushAdded.push({
        id: cloudId,
        type: node.type,
        parent_id: parentCloudId,
        root: node.root,
        name: node.name,
        url: node.url,
        position: node.position,
        date_added: node.date_added,
        date_modified: node.date_modified,
      });
      await IdMapStore.set(cloudId, {
        chrome_id: node.chrome_id,
        parent_cloud_id: parentCloudId,
        name: node.name,
        url: node.url,
        type: node.type,
        root: node.root,
        position: node.position,
        date_modified: node.date_modified || 0,
        synced_at: serverTime,
      });
    }

    // Step 5 — create cloud-only rows locally (skip tombstones).
    const cloudUnmatched = cloudList.filter(
      (c) => c.deleted_at == null && !matchedCloudIds.has(c.id)
    );
    const createOrder = topoSortForCreate(cloudUnmatched);
    let createdLocally = 0;

    for (const c of createOrder) {
      // Resolve parent Chrome id.
      let parentChromeId = null;
      if (c.parent_id) {
        const entry = await IdMapStore.getByCloudId(c.parent_id);
        parentChromeId = entry && entry.chrome_id ? entry.chrome_id : null;
      }
      if (!parentChromeId) {
        // Top-level under one of the Chrome roots.
        const rootChromeId = Object.keys(CHROME_ROOT_TO_KEY).find(
          (k) => CHROME_ROOT_TO_KEY[k] === c.root
        );
        parentChromeId = rootChromeId || '1';
      }

      try {
        const created = await createBookmark({
          parentId: parentChromeId,
          title: c.name || '',
          url: c.type === 'url' ? c.url || '' : undefined,
        });
        createdLocally++;
        await IdMapStore.set(c.id, {
          chrome_id: String(created.id),
          parent_cloud_id: c.parent_id || null,
          name: c.name,
          url: c.url,
          type: c.type,
          root: c.root,
          position: c.position ?? 0,
          date_modified: c.date_modified || 0,
          synced_at: serverTime,
        });
      } catch (err) {
        console.warn(
          `[MarkSync/initialMerge] failed to create local ${c.type} ${c.id}: ${err.message}`
        );
      }
    }

    // Step 6 — push locally-new bookmarks.
    if (pushAdded.length) {
      console.log(`[MarkSync/initialMerge] step6: POST /sync/push added=${pushAdded.length}`);
      await callApi(apiUrl, token, '/sync/push', {
        method: 'POST',
        body: { added: pushAdded, modified: [], removed: [] },
      });
    } else {
      console.log('[MarkSync/initialMerge] step6: nothing to push');
    }

    // Step 7 — persist idMap + syncState.
    await IdMapStore.save();
    await SyncState.update({
      initial_merge_done: true,
      last_pulled_at: serverTime,
      last_sync_at: serverTime,
      last_error: null,
    });

    console.log(
      `[MarkSync/initialMerge] done matched=${matchedCloudIds.size} added=${pushAdded.length} createdLocally=${createdLocally} dupLocal=${duplicateLocal}`
    );

    return {
      ok: true,
      matched: matchedCloudIds.size,
      added: pushAdded.length,
      remotePulled: cloudList.length,
    };
  } catch (err) {
    console.error('[MarkSync/initialMerge] failed:', err);
    try {
      await SyncState.update({ last_error: String(err && err.message || err) });
    } catch {
      /* ignore */
    }
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    globalThis.__marksyncSyncing = false;
  }
}

export default initialMerge;
