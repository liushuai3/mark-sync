// Empty-folder cleanup shared between initialMerge and syncCycle.
// Scans the local Chrome tree for empty (childless or only-subfolders)
// non-root folders, removes them locally, clears idMap entries, and
// lets the next sync cycle naturally push the deletions as tombstones.
import * as IdMapStore from './idMapStore.js';
import {
  getBookmarkTree,
  removeBookmark,
  findEmptyFolders,
  discoverRoots,
} from './bookmarkHelpers.js';

/**
 * Remove all empty folders from the local Chrome tree, clear their idMap
 * entries, and return counts. The caller (initialMerge/syncCycle) should
 * run this as a final cleanup step — tombstones will be pushed on the
 * next sync cycle via buildLocalDiff → `removed`.
 *
 * @param {object} opts
 * @param {string} opts.tag  Log prefix.
 * @returns {Promise<{localCount: number}>}
 */
export async function cleanupEmptyFolders({ tag }) {
  const tree = await getBookmarkTree();
  discoverRoots(tree);
  const chromeIds = findEmptyFolders(tree);
  if (!chromeIds.length) {
    console.log(`${tag} empty-folder: none found`);
    return { localCount: 0 };
  }

  let localCount = 0;
  for (const chromeId of chromeIds) {
    // Remove locally (idempotent — swallows "already gone").
    try {
      await removeBookmark(chromeId);
      localCount++;
    } catch (err) {
      console.warn(`${tag} empty-folder remove local ${chromeId}: ${err.message}`);
      continue;
    }
    // Clear idMap for this folder (deleted locally; next sync will push tombstone).
    try {
      await IdMapStore.deleteByChromeId(chromeId);
    } catch {
      // best-effort
    }
  }
  await IdMapStore.save();

  console.log(`${tag} empty-folder: removed ${localCount} locally`);
  return { localCount };
}

export default cleanupEmptyFolders;
