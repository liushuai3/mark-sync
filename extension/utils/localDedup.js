/**
 * @file localDedup.js
 * @description Local bookmark tree deduplication. Finds duplicate
 *   bookmarks/folders at the same (root, parent_chrome_id, name, url)
 *   position, keeps one (preferring idMap-linked entries), and removes
 *   the rest.
 *
 * Strategy:
 *   1. Walk the local Chrome tree via flattenLocalTree.
 *   2. Group by dedupe key = (root, parent_chrome_id, name, url).
 *   3. For groups with >1 entry, prefer the one already in idMap.
 *   4. Remove all others via chrome.bookmarks.remove.
 *   5. Clean up idMap entries for removed nodes.
 *
 * Called by both initialMerge (before the merge) and syncCycle (before
 * building the local diff). Idempotent — safe to call every cycle.
 *
 * @see SRS-v3.0 §FR-1.6 – local-duplicate policy
 */

import * as IdMapStore from './idMapStore.js';
import {
  getBookmarkTree,
  flattenLocalTree,
  removeBookmark,
  discoverRoots,
  CHROME_ROOT_TO_KEY,
} from './bookmarkHelpers.js';

/**
 * @param {{ tag: string, verbose?: boolean }} opts
 * @returns {Promise<{removed: number}>}
 */
export async function deduplicateLocalTree({ tag, verbose = true }) {
  const t0 = Date.now();
  const tree = await getBookmarkTree();
  discoverRoots(tree);

  if (verbose) {
    console.log(`${tag} dedup: roots discovered =>`, JSON.stringify(CHROME_ROOT_TO_KEY));
  }

  const localList = flattenLocalTree(tree);

  // Stats
  const folders = localList.filter((n) => n.type === 'folder').length;
  const urls = localList.filter((n) => n.type === 'url').length;
  console.log(`${tag} dedup: tree scanned — ${localList.length} nodes (${folders} folders, ${urls} urls) in ${Date.now() - t0}ms`);

  // Group by dedupe key: (root, parent_chrome_id, name, url)
  // parent_chrome_id is used instead of parent_path because it precisely
  // identifies which folder a node belongs to (two folders can have the
  // same name at different parent paths).
  /** @type {Map<string, string[]>} key -> chrome_ids */
  const groups = new Map();
  for (const n of localList) {
    const key = [
      n.root,
      n.parent_chrome_id || '',
      n.name,
      n.url || '',
    ].join('\u0000');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n.chrome_id);
  }

  // Find duplicate groups
  /** @type {Array<{key: string, ids: string[], sample: object}>} */
  const dupGroups = [];
  for (const [key, chromeIds] of groups) {
    if (chromeIds.length <= 1) continue;
    const parts = key.split('\u0000');
    dupGroups.push({
      key,
      ids: [...chromeIds],
      sample: {
        root: parts[0],
        parent_chrome_id: parts[1] || '(root)',
        name: parts[2],
        url: parts[3] || '(folder)',
      },
    });
  }

  if (verbose) {
    console.log(`${tag} dedup: ${dupGroups.length} duplicate groups found`);
    for (const g of dupGroups.slice(0, 20)) {
      console.log(`${tag} dedup:   [${g.sample.root}] parent=${g.sample.parent_chrome_id} name="${g.sample.name}" url="${g.sample.url}" → ${g.ids.length} copies (ids=${g.ids.join(',')})`);
    }
    if (dupGroups.length > 20) {
      console.log(`${tag} dedup:   ... and ${dupGroups.length - 20} more groups`);
    }
  }

  if (dupGroups.length === 0) {
    console.log(`${tag} dedup: done — nothing to remove`);
    return { removed: 0 };
  }

  // For each group, pick a survivor (prefer idMap-linked entry)
  let removed = 0;
  const failed = [];

  for (const g of dupGroups) {
    // Pick survivor: prefer one that exists in idMap (was synced before).
    let survivor = g.ids[0];
    for (const cid of g.ids) {
      try {
        const entry = await IdMapStore.getByChromeId(cid);
        if (entry && entry.cloud_id) {
          survivor = cid;
          break;
        }
      } catch {
        /* best-effort */
      }
    }

    // Delete all non-survivors
    for (const cid of g.ids) {
      if (cid === survivor) continue;
      try {
        await removeBookmark(cid);
        removed++;
        // Clean up idMap if this chrome_id was mapped.
        try {
          await IdMapStore.deleteByChromeId(cid);
        } catch {
          /* best-effort */
        }
        console.log(`${tag} dedup: removed chrome_id=${cid} (survivor=${survivor})`);
      } catch (err) {
        const msg = String(err?.message || err);
        failed.push({ cid, error: msg });
        console.warn(`${tag} dedup: FAILED to remove chrome_id=${cid} — ${msg}`);
      }
    }
  }

  if (failed.length > 0) {
    console.warn(`${tag} dedup: ${failed.length} remove failures`, failed.slice(0, 5));
  }

  if (removed > 0) {
    await IdMapStore.save();
  }

  console.log(`${tag} dedup: done — removed ${removed} duplicates, ${dupGroups.length - removed > 0 ? (dupGroups.length - removed) + ' groups skipped' : 'all groups processed'} in ${Date.now() - t0}ms`);
  return { removed };
}

export default deduplicateLocalTree;
