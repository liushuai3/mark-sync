/**
 * @file syncCycle.js
 * @description Recurring bidirectional sync between Chrome bookmarks and
 *   the MarkSync cloud (SRS-v3.0 §6.2). Runs after `initialMerge` has
 *   marked the client as reconciled; each cycle:
 *
 *     1. Pull remote deltas since `last_pulled_at` and apply them locally
 *        (tombstones first, then adds/mods in topological order).
 *     2. Diff the current Chrome tree against the id-map baseline to
 *        derive `added`/`modified`/`removed` payloads.
 *     3. Push the local diff and persist any LWW conflicts to `SyncState`.
 *
 * Concurrency: guarded by `globalThis.__marksyncSyncing`. A cycle skips if
 *   another sync is already in flight or if the initial merge has not run
 *   yet.
 *
 * Full-reset: when the server responds `full: true` on `/sync/pull` (i.e.
 *   `since` was rejected or older than the tombstone window), the caller
 *   is expected to run `initialMerge` again; this module simply returns
 *   `{skipped:true, reason:'reset'}` so the higher layer can decide.
 *
 * Performance target (SRS §NFR-1): 10 000 bookmarks under 3 seconds. All
 *   inner loops are O(n) with Map/Set indexes; we never scan the local
 *   tree more than twice.
 *
 * @see SRS-v3.0 §6.2 – recurring sync cycle
 * @see SRS-v3.0 §7 – conflict resolution (LWW / delete-wins)
 * @see SRS-v3.0 §9 – client state machine
 */

import * as IdMapStore from './idMapStore.js';
import * as SyncState from './syncState.js';
import { uuid } from './uuid.js';
import { cleanupEmptyFolders } from './emptyFolderCleanup.js';
import { deduplicateLocalTree } from './localDedup.js';
import {
  callApi,
  getBookmarkTree,
  createBookmark,
  updateBookmark,
  moveBookmark,
  removeBookmark,
  flattenLocalTree,
  topoSortForCreate,
  rootChromeIdFor,
  discoverRoots,
} from './bookmarkHelpers.js';

/**
 * Result envelope for a single sync cycle.
 * @typedef {{
 *   ok: boolean,
 *   added?: number,
 *   modified?: number,
 *   removed?: number,
 *   remoteApplied?: number,
 *   conflicts?: number,
 *   skipped?: boolean,
 *   reason?: string,
 *   error?: string,
 * }} SyncCycleResult
 */

/**
 * Run one bidirectional sync cycle. Safe to call repeatedly; the caller
 * (typically a background alarm) is responsible for scheduling.
 *
 * @param {object} opts
 * @param {string} opts.apiUrl  e.g. `https://marksync.zcoolq.cn/api`
 * @param {string} opts.token   MarkSync API token (`mks_...`)
 * @param {boolean} [opts.manual=false]  If true, this cycle was user-triggered
 *                                        (used only for log tagging).
 * @returns {Promise<SyncCycleResult>}
 */
export async function syncCycle({ apiUrl, token, manual = false }) {
  const tag = manual ? '[MarkSync/syncCycle:manual]' : '[MarkSync/syncCycle]';

  // ── 0. Concurrency guard ───────────────────────────────────────────
  if (globalThis.__marksyncSyncing) {
    console.log(`${tag} skipped – another sync is running`);
    return { ok: false, skipped: true, reason: 'busy' };
  }
  globalThis.__marksyncSyncing = true;

  try {
    if (!apiUrl || !token) {
      return { ok: false, error: 'apiUrl and token are required' };
    }

    const state = await SyncState.get();
    if (!state.initial_merge_done) {
      console.log(`${tag} skipped – initial merge not done`);
      return { ok: false, skipped: true, reason: 'needs_initial_merge' };
    }

    const since = Number(state.last_pulled_at) || 0;

    // ── 0.5  Local dedup (before sync, clean up any local duplicates) ──
    await deduplicateLocalTree({ tag });

    // ── 1. Pull remote deltas ────────────────────────────────────────
    console.log(`${tag} step1: GET /sync/pull?since=${since}`);
    const pullData = await callApi(
      apiUrl,
      token,
      `/sync/pull?since=${encodeURIComponent(since)}`
    );
    const cloudList = Array.isArray(pullData?.bookmarks) ? pullData.bookmarks : [];
    const serverTime = Number(pullData?.server_time) || Date.now();
    const full = pullData?.full === true;

    if (full && since > 0) {
      // `since` was rejected (older than tombstone retention). Caller
      // should re-run initialMerge; we bail out so we do not corrupt
      // local state with a partial resync.
      console.warn(`${tag} server returned full=true; caller must re-run initialMerge`);
      return { ok: false, skipped: true, reason: 'reset' };
    }

    // ── 1.5  Discover real root node IDs ────────────────────────
    // Must happen before applyRemoteChanges and buildLocalDiff so that
    // rootChromeIdFor and flattenLocalTree use the correct Chrome root IDs.
    const tree = await getBookmarkTree();
    discoverRoots(tree);

    // ── 2. Apply remote changes (delete → update → create) ───────────
    const remoteApplied = await applyRemoteChanges(cloudList, serverTime, tag);

    // ── 2.5  Local dedup (after remote creates, they may introduce duplicates) ──
    await deduplicateLocalTree({ tag });

    // ── 3. Build local diff (two-pass: assign cloud ids, then diff) ──
    const { added, modified, removed } = await buildLocalDiff(serverTime);

    // ── 4. Push local diff ───────────────────────────────────────────
    let conflicts = [];
    let pushCounts = { added_count: 0, modified_count: 0, removed_count: 0 };
    let backendDeduped = 0;
    if (added.length || modified.length || removed.length) {
      console.log(
        `${tag} step4: POST /sync/push added=${added.length} modified=${modified.length} removed=${removed.length}`
      );
      const pushRes = await callApi(apiUrl, token, '/sync/push', {
        method: 'POST',
        body: { added, modified, removed },
      });
      conflicts = Array.isArray(pushRes?.conflicts) ? pushRes.conflicts : [];
      pushCounts = {
        added_count: Number(pushRes?.added_count) || 0,
        modified_count: Number(pushRes?.modified_count) || 0,
        removed_count: Number(pushRes?.removed_count) || 0,
      };

      // Handle backend deduplication: the server may have merged some of our
      // `added` entries into existing cloud bookmarks. Update idMap so the
      // next cycle doesn't push the same duplicates again.
      const serverDeduped = Array.isArray(pushRes?.deduped) ? pushRes.deduped : [];
      if (serverDeduped.length > 0) {
        // Build a reverse lookup: requested_id -> original added entry
        const addedMap = new Map(added.map((a) => [a.id, a]));
        for (const d of serverDeduped) {
          const originalAdd = addedMap.get(d.requested_id);
          if (!originalAdd) continue;
          // Find the local chrome_id associated with this requested_id.
          // Walk staged to find the node that was assigned this cloud_id.
          // Since staged is local to buildLocalDiff, we track it differently.
          // Instead: iterate idMap entries to find one with cloud_id == d.requested_id.
          const tempEntry = await IdMapStore.getByCloudId(d.requested_id);
          if (tempEntry && tempEntry.chrome_id) {
            await IdMapStore.delete(d.requested_id);
            await IdMapStore.set(d.existing_id, {
              chrome_id: tempEntry.chrome_id,
              parent_cloud_id: originalAdd.parent_id || null,
              name: originalAdd.name,
              url: originalAdd.url,
              type: originalAdd.type,
              root: originalAdd.root,
              position: originalAdd.position,
              date_modified: originalAdd.date_modified || 0,
              synced_at: Date.now(),
            });
            backendDeduped++;
          }
        }
        if (backendDeduped > 0) {
          console.log(`${tag} backend deduped ${backendDeduped} duplicates`);
        }
      }
    } else {
      console.log(`${tag} step4: nothing to push`);
    }

    // ── 5. Log conflicts (client never mutates local on conflict, §7.3) ──
    for (const c of conflicts) {
      console.warn(
        `${tag} conflict id=${c.id} reason=${c.reason}` +
          (c.server_date_modified ? ` server_dm=${c.server_date_modified}` : '')
      );
    }

    // ── 6. Persist idMap + updated SyncState ─────────────────────────
    await IdMapStore.save();

    // Count active (non-deleted) remote bookmarks.
    // cloudList only has deltas on incremental pulls, so we can't use it.
    const remoteCount = await IdMapStore.size();
    await SyncState.update({
      last_pulled_at: serverTime,
      last_sync_at: Date.now(),
      last_conflicts: conflicts.length,
      last_error: null,
      remote_count: remoteCount,
    });

    // ── 7. Clean up empty folders ────────────────────────────
    await cleanupEmptyFolders({ tag });

    const summary = {
      ok: true,
      added: pushCounts.added_count,
      modified: pushCounts.modified_count,
      removed: pushCounts.removed_count,
      remoteApplied,
      conflicts: conflicts.length,
    };
    console.log(
      `${tag} done added=${summary.added} modified=${summary.modified} removed=${summary.removed} remote=${remoteApplied} conflicts=${summary.conflicts}`
    );
    return summary;
  } catch (err) {
    const msg = String((err && err.message) || err);
    console.error(`${tag} failed:`, err);
    try {
      await SyncState.update({ last_error: msg });
    } catch {
      /* ignore */
    }
    return { ok: false, error: msg };
  } finally {
    globalThis.__marksyncSyncing = false;
  }
}

/**
 * Apply remote changes to the local Chrome tree.
 *
 * Order of operations:
 *   1. Tombstones (`deleted_at != null`)  – remove locally (idempotent).
 *   2. Active rows – topologically sorted so parents materialise before
 *      children; existing rows get `update`/`move`, new rows `create`.
 *
 * @param {Array<object>} cloudList  Rows from `/sync/pull`.
 * @param {number} serverTime        Pull's `server_time` (ms).
 * @param {string} tag               Log prefix.
 * @returns {Promise<number>}        Count of applied remote mutations.
 */
async function applyRemoteChanges(cloudList, serverTime, tag) {
  if (!cloudList.length) return 0;

  let applied = 0;
  const tombstones = [];
  const active = [];
  for (const r of cloudList) {
    if (r.deleted_at != null) tombstones.push(r);
    else active.push(r);
  }

  // 1) Tombstones first – parents before children is not strictly
  //    required for delete, but chrome.bookmarks.remove on a folder
  //    also removes descendants, so processing top-down keeps counts
  //    accurate and avoids "already removed" noise.
  for (const r of tombstones) {
    const entry = await IdMapStore.getByCloudId(r.id);
    if (entry && entry.chrome_id) {
      try {
        await removeBookmark(entry.chrome_id);
      } catch (err) {
        // remove() is best-effort idempotent; swallow "already gone".
        console.warn(`${tag} remote-delete failed id=${r.id}: ${err.message}`);
      }
    }
    await IdMapStore.delete(r.id);
    applied++;
  }

  // 2) Active rows in parent-first order.
  const ordered = topoSortForCreate(active);
  for (const r of ordered) {
    const entry = await IdMapStore.getByCloudId(r.id);

    if (entry) {
      // Existing mapping → update/move as needed.
      const nameChanged = (entry.name || '') !== (r.name || '');
      const urlChanged = (entry.url || null) !== (r.url || null);
      if (nameChanged || urlChanged) {
        try {
          await updateBookmark(entry.chrome_id, {
            title: r.name || '',
            ...(r.type === 'url' ? { url: r.url || '' } : {}),
          });
        } catch (err) {
          console.warn(`${tag} remote-update failed id=${r.id}: ${err.message}`);
        }
      }

      const parentChanged = (entry.parent_cloud_id || null) !== (r.parent_id || null);
      const posChanged = (entry.position ?? 0) !== (r.position ?? 0);
      if (parentChanged || posChanged) {
        const parentChromeId = await resolveParentChromeId(r.parent_id, r.root);
        if (parentChromeId) {
          try {
            await moveBookmark(entry.chrome_id, {
              parentId: parentChromeId,
              index: r.position ?? 0,
            });
          } catch (err) {
            console.warn(`${tag} remote-move failed id=${r.id}: ${err.message}`);
          }
        } else {
          console.warn(`${tag} remote-move deferred id=${r.id} – parent not mapped`);
        }
      }

      await IdMapStore.set(r.id, {
        chrome_id: entry.chrome_id,
        parent_cloud_id: r.parent_id || null,
        name: r.name,
        url: r.url,
        type: r.type,
        root: r.root,
        position: r.position ?? 0,
        date_modified: r.date_modified || 0,
        synced_at: serverTime,
      });
      applied++;
      continue;
    }

    // No mapping → create locally.
    const parentChromeId = await resolveParentChromeId(r.parent_id, r.root);
    try {
      const created = await createBookmark({
        parentId: parentChromeId,
        title: r.name || '',
        index: r.position ?? undefined,
        url: r.type === 'url' ? r.url || '' : undefined,
      });
      await IdMapStore.set(r.id, {
        chrome_id: String(created.id),
        parent_cloud_id: r.parent_id || null,
        name: r.name,
        url: r.url,
        type: r.type,
        root: r.root,
        position: r.position ?? 0,
        date_modified: r.date_modified || 0,
        synced_at: serverTime,
      });
      applied++;
    } catch (err) {
      console.warn(`${tag} remote-create failed id=${r.id}: ${err.message}`);
    }
  }

  return applied;
}

/**
 * Resolve the Chrome parent id for a cloud row. Falls back to the root
 * folder for `rootKey` when no mapping exists yet (top-level row).
 * @param {string | null | undefined} parentCloudId
 * @param {string} rootKey
 * @returns {Promise<string>}
 */
async function resolveParentChromeId(parentCloudId, rootKey) {
  if (parentCloudId) {
    const parentEntry = await IdMapStore.getByCloudId(parentCloudId);
    if (parentEntry && parentEntry.chrome_id) return String(parentEntry.chrome_id);
  }
  return rootChromeIdFor(rootKey);
}

/**
 * Diff the current Chrome tree against the id-map baseline. Two passes:
 *
 *   Pass 1 – walk every local node; if it lacks a cloud id, first check
 *            whether an existing idMap entry already covers the same
 *            (root, parent_path, name, url) dedupe key. If so, reuse that
 *            cloud_id. Otherwise allocate a new uuid v4.
 *   Pass 2 – for every node, either compare with its idMap baseline and
 *            push into `modified` on any field change, or emit `added`
 *            using the parent's now-known cloud id.
 *   Pass 3 – iterate the id-map to find entries whose chrome_id has
 *            disappeared and emit them as `removed`.
 *
 * @param {number} now  Timestamp to stamp on new/modified/removed records.
 * @returns {Promise<{added: object[], modified: object[], removed: object[]}>}
 */
async function buildLocalDiff(now) {
  const tree = await getBookmarkTree();
  const localList = flattenLocalTree(tree);

  // Index by chrome_id for O(1) lookup.
  /** @type {Set<string>} */
  const localChromeIds = new Set(localList.map((l) => String(l.chrome_id)));

  // Build a dedupe index from existing idMap entries to detect
  // locally-new bookmarks that should reuse an existing cloud_id.
  // Key = (root, parent_path, name, url) where parent_path is
  // derived from parent_cloud_id chain (approximate — may differ from
  // flattenLocalTree's DFS path, but good enough for dedup).
  const allEntries = await IdMapStore.all();
  /** @type {Map<string, string>} dedupe_key -> cloud_id */
  const dedupeToCloudId = new Map();
  for (const e of allEntries) {
    if (!e || !e.cloud_id) continue;
    const parentPath = e.parent_cloud_id
      ? (allEntries.find((x) => x && x.cloud_id === e.parent_cloud_id)?.name || '')
      : '';
    const key = `${e.root || ''}\u0000${parentPath}\u0000${e.name || ''}\u0000${e.url || ''}`;
    if (!dedupeToCloudId.has(key)) {
      dedupeToCloudId.set(key, e.cloud_id);
    }
  }

  // Pass 1: assign cloud ids to locally-new nodes so pass 2 can resolve
  // parent_id references (parents may themselves be brand-new).
  //
  // Local order from flattenLocalTree is pre-order DFS, which already
  // guarantees parents come before children.
  /** @type {Map<string, string>} chrome_id -> cloud_id */
  const chromeToCloudId = new Map();
  /** @type {Array<{node: import('./bookmarkHelpers.js').LocalNode, cloudId: string, isNew: boolean}>} */
  const staged = [];

  let localDedupCount = 0;
  for (const l of localList) {
    const chromeId = String(l.chrome_id);
    const existing = await IdMapStore.getByChromeId(chromeId);
    if (existing && existing.cloud_id) {
      chromeToCloudId.set(chromeId, existing.cloud_id);
      staged.push({ node: l, cloudId: existing.cloud_id, isNew: false });
    } else {
      // Check local dedup: does idMap already have an entry with same content?
      const dk = `${l.root}\u0000${l.parent_path}\u0000${l.name}\u0000${l.url || ''}`;
      const existingCloudId = dedupeToCloudId.get(dk);
      if (existingCloudId) {
        // Reuse existing cloud_id — this bookmark was already synced by
        // another browser or a prior initialMerge.
        chromeToCloudId.set(chromeId, existingCloudId);
        staged.push({ node: l, cloudId: existingCloudId, isNew: false });
        localDedupCount++;
      } else {
        const newId = uuid();
        chromeToCloudId.set(chromeId, newId);
        staged.push({ node: l, cloudId: newId, isNew: true });
      }
    }
  }
  if (localDedupCount > 0) {
    console.log(`[MarkSync/syncCycle] local dedup: ${localDedupCount} nodes reused existing cloud_ids`);
  }

  // Pass 2: build `added` and `modified`.
  /** @type {object[]} */
  const added = [];
  /** @type {object[]} */
  const modified = [];

  for (const { node, cloudId, isNew } of staged) {
    const parentCloudId = node.parent_chrome_id
      ? chromeToCloudId.get(String(node.parent_chrome_id)) || null
      : null;

    if (isNew) {
      added.push({
        id: cloudId,
        type: node.type,
        parent_id: parentCloudId,
        root: node.root,
        name: node.name,
        url: node.url,
        position: node.position,
        date_added: node.date_added,
        date_modified: now,
      });
      await IdMapStore.set(cloudId, {
        chrome_id: String(node.chrome_id),
        parent_cloud_id: parentCloudId,
        name: node.name,
        url: node.url,
        type: node.type,
        root: node.root,
        position: node.position,
        date_modified: now,
        synced_at: now,
      });
      continue;
    }

    // Existing mapping → check for field-level changes.
    // Note: `isNew: false` can mean either (a) an existing idMap entry from
    // a prior sync, or (b) a dedup-match in Pass 1 where we reused a cloud_id
    // from another browser's bookmark.
    const baseline = await IdMapStore.getByCloudId(cloudId);

    // Case (b): dedup-matched node — create a fresh idMap entry pointing to
    // the existing cloud_id. No need to push anything since the cloud already
    // has this bookmark.
    if (!baseline) {
      await IdMapStore.set(cloudId, {
        chrome_id: String(node.chrome_id),
        parent_cloud_id: parentCloudId,
        name: node.name,
        url: node.url,
        type: node.type,
        root: node.root,
        position: node.position,
        date_modified: now,
        synced_at: now,
      });
      continue;
    }

    const changes = {};
    let dirty = false;
    if ((baseline.name || '') !== (node.name || '')) {
      changes.name = node.name;
      dirty = true;
    }
    if ((baseline.url || null) !== (node.url || null)) {
      changes.url = node.url;
      dirty = true;
    }
    if ((baseline.parent_cloud_id || null) !== (parentCloudId || null)) {
      changes.parent_id = parentCloudId;
      dirty = true;
    }
    if ((baseline.position ?? 0) !== (node.position ?? 0)) {
      changes.position = node.position;
      dirty = true;
    }

    if (dirty) {
      modified.push({ id: cloudId, ...changes, date_modified: now });
      await IdMapStore.set(cloudId, {
        chrome_id: baseline.chrome_id,
        parent_cloud_id: parentCloudId,
        name: node.name,
        url: node.url,
        type: baseline.type,
        root: node.root,
        position: node.position,
        date_modified: now,
        synced_at: baseline.synced_at || 0,
      });
    }
  }

  // Pass 3: id-map entries whose chrome_id is gone → removed.
  /** @type {object[]} */
  const removed = [];
  const entries = await IdMapStore.all();
  for (const entry of entries) {
    if (!entry || !entry.cloud_id) continue;
    const chromeId = entry.chrome_id ? String(entry.chrome_id) : null;
    if (chromeId && localChromeIds.has(chromeId)) continue;
    removed.push({ id: entry.cloud_id, date_modified: now });
    await IdMapStore.delete(entry.cloud_id);
  }

  return { added, modified, removed };
}

export default syncCycle;
