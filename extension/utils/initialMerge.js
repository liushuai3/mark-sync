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
import { deduplicateLocalTree } from './localDedup.js';
import {
  callApi,
  getBookmarkTree,
  createBookmark,
  flattenLocalTree,
  computeCloudPaths,
  topoSortForCreate,
  rootChromeIdFor,
  discoverRoots,
} from './bookmarkHelpers.js';

/**
 * @typedef {import('./bookmarkHelpers.js').LocalNode} LocalNode
 * @typedef {import('./bookmarkHelpers.js').RootKey} RootKey
 */

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

  // Guard: if initialMerge already completed on this browser, skip
  // and let the caller fall through to SYNC_NOW. Re-running de-dupes
  // differently and creates phantom empty folders.
  const existingState = await SyncState.get();
  if (existingState && existingState.initial_merge_done) {
    console.log('[MarkSync/initialMerge] already done, skipping');
    return { ok: true, skipped: true, reason: 'already_done' };
  }

  globalThis.__marksyncSyncing = true;

  try {
    if (!apiUrl || !token) {
      return { ok: false, error: 'apiUrl and token are required' };
    }

    // ── 0.5  Local dedup (clean up any local duplicates before merge) ──
    await deduplicateLocalTree({ tag: '[MarkSync/initialMerge]' });

    // Step 1 — pull full remote state.
    const pullData = await callApi(apiUrl, token, '/sync/pull');
    const cloudList = Array.isArray(pullData?.bookmarks) ? pullData.bookmarks : [];
    const serverTime = Number(pullData?.server_time) || Date.now();

    // Step 2 — flatten local tree.
    // First discover real root node IDs (some browsers use non-canonical IDs).
    const tree = await getBookmarkTree();
    discoverRoots(tree);
    const localList = flattenLocalTree(tree);

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
    // Collect unmatched cloud rows, but also handle cloud-side duplicates:
    // if a cloud row has the same dedupe key as an already-matched one,
    // bind it to the same local chrome_id instead of creating a new entry.
    const cloudUnmatched = cloudList.filter(
      (c) => c.deleted_at == null && !matchedCloudIds.has(c.id)
    );

    // Cloud-side dedup: entries with same dedupe key as an already-matched row
    // get bound immediately (no local create). These are duplicates from pre-fix
    // multi-browser initial merges.
    let cloudDedupBound = 0;
    const trulyUnmatched = [];
    for (const c of cloudUnmatched) {
      const key = dedupeKey(c.root, cloudPaths.get(c.id) || '', c.name, c.url);
      const cloudAlreadyMatched = cloudByKey.get(key);
      if (cloudAlreadyMatched && matchedCloudIds.has(cloudAlreadyMatched.id)) {
        // Cloud duplicate — find the chrome_id already bound to the primary cloud row.
        let primaryChrome = null;
        for (const [chId, clId] of chromeToCloud) {
          if (clId === cloudAlreadyMatched.id) { primaryChrome = chId; break; }
        }
        if (primaryChrome) {
          await IdMapStore.set(c.id, {
            chrome_id: primaryChrome,
            parent_cloud_id: c.parent_id || null,
            name: c.name,
            url: c.url,
            type: c.type,
            root: c.root,
            position: c.position ?? 0,
            date_modified: c.date_modified || 0,
            synced_at: serverTime,
          });
          cloudDedupBound++;
          continue;
        }
      }
      trulyUnmatched.push(c);
    }

    const createOrder = topoSortForCreate(trulyUnmatched);
    let createdLocally = 0;
    let createErrors = 0;

    for (const c of createOrder) {
      // Resolve parent Chrome id.
      let parentChromeId = null;
      if (c.parent_id) {
        const entry = await IdMapStore.getByCloudId(c.parent_id);
        parentChromeId = entry && entry.chrome_id ? entry.chrome_id : null;
      }
      if (!parentChromeId) {
        // Top-level under one of the Chrome roots.
        parentChromeId = rootChromeIdFor(c.root);
      }

      try {
        if (!parentChromeId) {
          console.warn(
            `[MarkSync/initialMerge] no parentChromeId for "${c.name}" — skipping`
          );
          createErrors++;
          continue;
        }
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
        createErrors++;
        console.warn(
          `[MarkSync/initialMerge] failed to create local ${c.type} "${c.name}" (${c.id}): ${err.message}`
        );
      }
    }

    // Step 6 — push locally-new bookmarks.

    // ── 5.5  Local dedup (cloud-only creates may have introduced duplicates) ──
    await deduplicateLocalTree({ tag: '[MarkSync/initialMerge]' });

    let backendDeduped = 0;
    if (pushAdded.length) {
      const pushRes = await callApi(apiUrl, token, '/sync/push', {
        method: 'POST',
        body: { added: pushAdded, modified: [], removed: [] },
      });

      // Handle backend deduplication: the server may return `deduped` when
      // another browser already pushed the same bookmark with a different UUID.
      const serverDeduped = Array.isArray(pushRes?.deduped) ? pushRes.deduped : [];
      if (serverDeduped.length > 0) {
        // Build a lookup: requested_id -> { node, cloudId }
        const requestMap = new Map(localToPush.map(({ node, cloudId }) => [cloudId, { node, cloudId }]));
        for (const d of serverDeduped) {
          const entry = requestMap.get(d.requested_id);
          if (!entry) continue;
          // Replace the fresh UUID mapping with the server's existing cloud_id.
          // The local chrome_id now maps to the correct cloud_id.
          await IdMapStore.delete(d.requested_id);
          await IdMapStore.set(d.existing_id, {
            chrome_id: entry.node.chrome_id,
            parent_cloud_id: entry.node.parent_chrome_id
              ? (chromeIdToAssignedCloudId.get(entry.node.parent_chrome_id) || null)
              : null,
            name: entry.node.name,
            url: entry.node.url,
            type: entry.node.type,
            root: entry.node.root,
            position: entry.node.position,
            date_modified: entry.node.date_modified || 0,
            synced_at: serverTime,
          });
          // Also update chromeIdToAssignedCloudId so children can resolve correctly.
          chromeIdToAssignedCloudId.set(entry.node.chrome_id, d.existing_id);
          backendDeduped++;
        }
        console.log(`[MarkSync/initialMerge] backend deduped ${backendDeduped} duplicates`);
      }
    } else {
      // no local additions to push
    }

    // Step 7 — persist idMap + syncState.
    await IdMapStore.save();
    await SyncState.update({
      initial_merge_done: true,
      last_pulled_at: serverTime,
      last_sync_at: serverTime,
      last_error: null,
      remote_count: cloudList.filter((b) => b.deleted_at == null).length,
    });

    return {
      ok: true,
      matched: matchedCloudIds.size,
      added: pushAdded.length,
      createdLocally,
      createErrors,
      cloudDedupBound,
      backendDeduped,
      remotePulled: cloudList.length,
      remoteNew: trulyUnmatched.length,
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
