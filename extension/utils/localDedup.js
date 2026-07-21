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
} from './bookmarkHelpers.js';

/**
 * @param {{ tag: string }} opts
 * @returns {Promise<{removed: number}>}
 */
export async function deduplicateLocalTree({ tag }) {
  const tree = await getBookmarkTree();
  discoverRoots(tree);
  const localList = flattenLocalTree(tree);

  // Group by (root, parent_chrome_id, name, url)
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

  let removed = 0;
  const idsToDelete = [];

  for (const [, chromeIds] of groups) {
    if (chromeIds.length <= 1) continue;

    // Pick survivor: prefer one that exists in idMap (was synced before).
    let survivor = chromeIds[0];
    for (const cid of chromeIds) {
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

    for (const cid of chromeIds) {
      if (cid === survivor) continue;
      idsToDelete.push(cid);
    }
  }

  // Delete in reverse order to minimize Chrome API calls
  // (removing a folder also removes children, so we don't need to
  //  separately delete children — they'll be caught in this pass).
  for (const cid of idsToDelete) {
    try {
      await removeBookmark(cid);
      removed++;
      // Clean up idMap if this chrome_id was mapped.
      try {
        await IdMapStore.deleteByChromeId(cid);
      } catch {
        /* best-effort */
      }
    } catch (err) {
      // Already removed (parent folder removal cascaded) — fine.
    }
  }

  if (removed > 0) {
    await IdMapStore.save();
    console.log(`${tag} local dedup: removed ${removed} duplicates`);
  } else {
    console.log(`${tag} local dedup: none found`);
  }

  return { removed };
}

export default deduplicateLocalTree;
