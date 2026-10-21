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

    // Tombstone-window reset pending (set by a prior cycle or a crash
    // mid-cycle). Bail out BEFORE any pull/push so state is not corrupted;
    // the caller (background) must run initialMerge in re-merge mode.
    // Without this guard a device offline >30d loops on full=true forever.
    if (state.reset_pending) {
      console.log(`${tag} skipped – reset pending, caller must re-merge`);
      return { ok: false, skipped: true, reason: 'reset' };
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
      // `since` was rejected (older than tombstone retention). Flag a
      // reset so the next cycle / the background layer runs initialMerge
      // in re-merge mode. We bail out so we do not corrupt local state
      // with a partial resync. (P0-1 fix: this used to just return a skip
      // nothing acted on → sync silently stopped forever.)
      console.warn(`${tag} server returned full=true; flagging reset for re-merge`);
      await SyncState.update({ reset_pending: true });
      return { ok: false, skipped: true, reason: 'reset' };
    }

    // ── 1.5  Discover real root node IDs ────────────────────────
    // Must happen before applyRemoteChanges and buildLocalDiff so that
    // rootChromeIdFor and flattenLocalTree use the correct Chrome root IDs.
    const tree = await getBookmarkTree();
    discoverRoots(tree);

    // ── 2. Apply remote changes (delete → update → create) ───────────
    const applyResult = await applyRemoteChanges(cloudList, serverTime, tag);
    const remoteApplied = applyResult.applied;
    const applyFailures = applyResult.failures;

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

    // ── P0-5: pull checkpoint discipline ──────────────────────────────
    // Only advance `last_pulled_at` when EVERY remote row applied cleanly.
    // On failure keep the old `since` so failed rows are re-pulled and
    // retried next cycle (pull is ordered by server_updated_at; replaying
    // already-applied rows is a cheap no-op). Advancing past a failed
    // create used to orphan that subtree in the cloud forever.
    // Streak cap: after 6 consecutive failed cycles, one permanently-bad
    // row must not wedge sync forever — advance anyway, keep the error
    // visible, and (for unmapped parents) flag a full re-merge instead.
    const prevStreak = Number(state.failed_apply_streak) || 0;
    const streak = applyFailures.length > 0 ? prevStreak + 1 : 0;
    const wedged = applyFailures.length > 0 && streak >= 6;
    const hasParentGap = applyFailures.some((f) => f.reason === 'parent-unmapped');
    const advanceSince = applyFailures.length === 0 || wedged ? serverTime : since;

    await SyncState.update({
      last_pulled_at: advanceSince,
      last_sync_at: Date.now(),
      last_conflicts: conflicts.length,
      last_error:
        applyFailures.length > 0
          ? `apply failures: ${applyFailures.length} (${applyFailures[0].reason})` +
            (wedged ? ' – checkpoint released after 6 cycles' : ' – will retry')
          : null,
      failed_apply_streak: wedged ? 0 : streak,
      ...(wedged && hasParentGap ? { reset_pending: true } : {}),
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
      applyFailures: applyFailures.length,
    };
    console.log(
      `${tag} done added=${summary.added} modified=${summary.modified} removed=${summary.removed} remote=${remoteApplied} conflicts=${summary.conflicts}` +
        (applyFailures.length ? ` applyFailures=${applyFailures.length}` : '')
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
 * @returns {Promise<{applied: number, failures: Array<{id: string, reason: string}>}>}
 *   `applied` = count of local mutations performed; `failures` = rows that
 *   could not be applied cleanly. The caller MUST keep the pull checkpoint
 *   behind any failure so those rows are re-pulled and retried.
 */
async function applyRemoteChanges(cloudList, serverTime, tag) {
  if (!cloudList.length) return { applied: 0, failures: [] };

  // Stats for diagnostics
  const tombstones = [];
  const active = [];
  for (const r of cloudList) {
    if (r.deleted_at != null) tombstones.push(r);
    else active.push(r);
  }
  console.log(`${tag} applyRemote: ${active.length} active + ${tombstones.length} tombstones`);

  let applied = 0;
  let creates = 0;
  let updates = 0;
  /**
   * Rows that could not be applied cleanly this cycle. The caller keeps
   * `last_pulled_at` behind these so they are re-pulled and retried.
   * NEVER advance state past a failure — doing so was the root cause of
   * "remote subtree permanently missing on this device".
   * @type {Array<{id: string, reason: string}>}
   */
  const failures = [];

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
        const msg = String((err && err.message) || err);
        // remove() is idempotent only for "already gone". Any other
        // failure must KEEP the idMap entry — dropping it made the next
        // diff treat the still-present local bookmark as brand new, mint a
        // fresh uuid and RESURRECT the deleted row (delete-wins broken).
        if (/cannot find|does not exist|not found/i.test(msg)) {
          console.warn(`${tag} remote-delete already-gone id=${r.id}`);
        } else {
          failures.push({ id: r.id, reason: `local-remove: ${msg}` });
          console.warn(`${tag} remote-delete FAILED id=${r.id}: ${msg} – mapping kept, will retry`);
          continue;
        }
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
      //
      // P0-4: idMap may only record mutations that ACTUALLY succeeded on
      // the local tree. The old code wrote the remote values unconditionally;
      // after a failed local update/move the next diff saw "local is dirty"
      // and pushed the stale local value back over the remote edit
      // (ping-pong lost update).
      const nameChanged = (entry.name || '') !== (r.name || '');
      const urlChanged = (entry.url || null) !== (r.url || null);
      let contentOk = true;
      if (nameChanged || urlChanged) {
        try {
          await updateBookmark(entry.chrome_id, {
            title: r.name || '',
            ...(r.type === 'url' ? { url: r.url || '' } : {}),
          });
          updates++;
        } catch (err) {
          contentOk = false;
          failures.push({ id: r.id, reason: `local-update: ${err.message}` });
          console.warn(`${tag} remote-update failed id=${r.id}: ${err.message} – will retry`);
        }
      }

      const parentChanged = (entry.parent_cloud_id || null) !== (r.parent_id || null);
      const posChanged = (entry.position ?? 0) !== (r.position ?? 0);
      let moveOk = true;
      if (parentChanged || posChanged) {
        let parentChromeId = null;
        if (r.parent_id) {
          const parentEntry = await IdMapStore.getByCloudId(r.parent_id);
          if (parentEntry && parentEntry.chrome_id) {
            parentChromeId = String(parentEntry.chrome_id);
          } else {
            // P1-5: parent not mapped (its create failed / arrives later) →
            // DEFER the move. The old fallback dumped the node at the
            // bookmark-bar root, and the next diff then pushed that wrong
            // position to the cloud — permanent position drift.
            moveOk = false;
            failures.push({ id: r.id, reason: 'parent-unmapped' });
            console.warn(`${tag} remote-move deferred id=${r.id} – parent not mapped`);
          }
        } else {
          parentChromeId = rootChromeIdFor(r.root);
        }
        if (moveOk) {
          try {
            await moveBookmark(entry.chrome_id, {
              parentId: parentChromeId,
              index: r.position ?? 0,
            });
          } catch (err) {
            moveOk = false;
            failures.push({ id: r.id, reason: `local-move: ${err.message}` });
            console.warn(`${tag} remote-move failed id=${r.id}: ${err.message} – will retry`);
          }
        }
      }

      await IdMapStore.set(r.id, {
        chrome_id: entry.chrome_id,
        parent_cloud_id: moveOk ? r.parent_id || null : entry.parent_cloud_id || null,
        name: contentOk ? r.name : entry.name,
        url: contentOk ? r.url : entry.url,
        type: r.type,
        root: r.root,
        position: moveOk ? r.position ?? 0 : entry.position ?? 0,
        date_modified: contentOk && moveOk ? r.date_modified || 0 : entry.date_modified || 0,
        synced_at: serverTime,
      });
      applied++;
      continue;
    }

    // No mapping → create locally.
    //
    // P0-4/P1-5: the parent MUST resolve — never fall back to the root
    // folder. A node created at the wrong place made the next diff push
    // the wrong parent_id to the cloud, permanently relocating the row.
    // If the parent isn't mapped we defer (→ failure → checkpoint stays
    // behind → the row is retried once its parent has been created).
    let parentChromeId = null;
    if (r.parent_id) {
      const parentEntry = await IdMapStore.getByCloudId(r.parent_id);
      if (parentEntry && parentEntry.chrome_id) {
        parentChromeId = String(parentEntry.chrome_id);
      } else {
        failures.push({ id: r.id, reason: 'parent-unmapped' });
        console.warn(`${tag} remote-create deferred id=${r.id} – parent not mapped`);
        continue;
      }
    } else {
      parentChromeId = rootChromeIdFor(r.root);
    }
    try {
      const created = await createBookmark({
        parentId: parentChromeId,
        title: r.name || '',
        index: r.position ?? undefined,
        url: r.type === 'url' ? r.url || '' : undefined,
      });
      creates++;
      console.log(`${tag} applyRemote: CREATE local chrome_id=${created.id} cloud_id=${r.id} name="${r.name}" type=${r.type} parent=${parentChromeId}`);
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
      failures.push({ id: r.id, reason: `local-create: ${err.message}` });
      console.warn(`${tag} remote-create failed id=${r.id}: ${err.message} – will retry`);
    }
  }

  console.log(
    `${tag} applyRemote: done — ${applied} applied (${creates} local-creates + ${tombstones.length} tombstones), ${failures.length} deferred/failed`
  );
  return { applied, failures };
}

// (Removed) resolveParentChromeId: its silent fallback to the root folder
// caused remote rows whose parent was not yet mapped to be created at the
// bookmark-bar root and then pushed back to the cloud as top-level —
// position drift. Callers now resolve the parent explicitly and defer the
// row as a failure when the parent is unmapped.

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
  console.log(`[MarkSync/syncCycle] buildDiff: dedupe index has ${dedupeToCloudId.size} unique keys from ${allEntries.length} idMap entries`);

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

  console.log(`[MarkSync/syncCycle] buildDiff: result added=${added.length} modified=${modified.length} removed=${removed.length}`);
  return { added, modified, removed };
}

export default syncCycle;
