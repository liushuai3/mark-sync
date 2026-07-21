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
 * Helper: get children of a Chrome bookmark folder.
 * @param {string} parentId
 * @returns {Promise<chrome.bookmarks.BookmarkTreeNode[]>}
 */
function getChildren(parentId) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.getChildren(String(parentId), (children) => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve(children || []);
    });
  });
}

/**
 * Helper: move a bookmark to a new parent.
 */
function moveToParent(childId, newParentId) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.move(String(childId), { parentId: String(newParentId) }, () => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

/**
 * Recursively merge all children from victim folder into survivor folder.
 * - Leaf bookmarks: move unique ones, delete duplicates.
 * - Sub-folders: recursively merge matching ones, move unique ones.
 * After this, the victim folder should be empty and safe to remove.
 *
 * @param {{ victimId: string, survivorId: string, tag: string }} opts
 * @returns {Promise<{moves: number, childDeletes: number, subfoldersMerged: number}>}
 */
async function mergeChildrenRecursive({ victimId, survivorId, tag }) {
  const [vChildren, sChildren] = await Promise.all([
    getChildren(victimId),
    getChildren(survivorId),
  ]);

  // Index survivor children by (title, url) for O(1) lookup
  const sIndex = new Map();
  for (const c of sChildren) {
    sIndex.set(`${c.title || ''}\u0000${c.url || ''}`, c);
  }

  let moves = 0;
  let childDeletes = 0;
  let subfoldersMerged = 0;

  // Process victim children one by one.
  // Use a copy of the array since we may mutate the tree.
  const toProcess = [...vChildren];

  for (const vChild of toProcess) {
    const childKey = `${vChild.title || ''}\u0000${vChild.url || ''}`;
    const sMatch = sIndex.get(childKey);

    if (vChild.url) {
      // ── Leaf bookmark ──
      if (sMatch) {
        // Same title+url already exists in survivor → delete this duplicate.
        try {
          await removeBookmark(String(vChild.id));
          childDeletes++;
        } catch (err) {
          console.warn(`${tag} dedup: child-delete failed id=${vChild.id}: ${err.message}`);
        }
      } else {
        // Unique → move to survivor.
        await moveToParent(String(vChild.id), survivorId);
        moves++;
      }
    } else {
      // ── Sub-folder ──
      if (sMatch) {
        // Same-named folder exists in survivor → recursively merge.
        const sub = await mergeChildrenRecursive({
          victimId: String(vChild.id),
          survivorId: String(sMatch.id),
          tag,
        });
        moves += sub.moves;
        childDeletes += sub.childDeletes;
        subfoldersMerged += 1 + sub.subfoldersMerged;
        // After recursive merge, the victim sub-folder should be empty.
        try {
          await removeBookmark(String(vChild.id));
        } catch (err) {
          console.warn(`${tag} dedup: subfolder-remove failed id=${vChild.id}: ${err.message}`);
          // Fallback: use removeTree if remove fails (shouldn't happen if merge was clean)
          try {
            await new Promise((resolve, reject) => {
              chrome.bookmarks.removeTree(String(vChild.id), () => {
                const e = chrome.runtime?.lastError;
                if (e) reject(new Error(e.message));
                else resolve();
              });
            });
          } catch {
            /* best-effort */
          }
        }
      } else {
        // Unique folder → move to survivor (with all its contents).
        await moveToParent(String(vChild.id), survivorId);
        moves++;
      }
    }
  }

  return { moves, childDeletes, subfoldersMerged };
}

/**
 * Merge a duplicate folder's entire subtree into the survivor folder.
 * Uses recursive merging: children are moved/merged level by level,
 * preserving all unique bookmarks and only deleting true duplicates.
 *
 * @param {{ victimId: string, survivorId: string, tag: string }} opts
 * @returns {Promise<void>}
 */
async function mergeFolderInto({ victimId, survivorId, tag }) {
  const result = await mergeChildrenRecursive({ victimId, survivorId, tag });

  console.log(
    `${tag} dedup: mergeFolder victim=${victimId} -> survivor=${survivorId}: ` +
    `${result.moves} moved, ${result.childDeletes} duplicates deleted, ` +
    `${result.subfoldersMerged} sub-folders merged`
  );

  // After recursive merge, victim should be empty. Remove it.
  try {
    await removeBookmark(String(victimId));
  } catch (err) {
    // Fallback: removeTree in case something was left behind.
    console.warn(`${tag} dedup: folder-remove failed id=${victimId}: ${err.message}, trying removeTree`);
    await new Promise((resolve, reject) => {
      chrome.bookmarks.removeTree(String(victimId), () => {
        const e = chrome.runtime?.lastError;
        if (e) reject(new Error(e.message));
        else resolve();
      });
    });
  }
}

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

  // Sort groups by depth: fewer path segments = shallower = process first.
  // This ensures parent folders are merged before their children.
  dupGroups.sort((a, b) => {
    const aLen = a.key.split('\u0000').filter(Boolean).length;
    const bLen = b.key.split('\u0000').filter(Boolean).length;
    // Also sort by parent_chrome_id: root-level (empty parent) first
    const aParent = a.key.split('\u0000')[1] || '';
    const bParent = b.key.split('\u0000')[1] || '';
    if (aParent && !bParent) return 1;
    if (!aParent && bParent) return -1;
    return aLen - bLen;
  });

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

    // Determine if these are folders (need recursive merge) or leaf bookmarks.
    const sample = localList.find((n) => n.chrome_id === g.ids[0]);
    const isFolder = sample && sample.type === 'folder';

    for (const cid of g.ids) {
      if (cid === survivor) continue;
      try {
        if (isFolder) {
          // Folder merge: move victim's children to survivor, then removeTree.
          await mergeFolderInto({ victimId: cid, survivorId: survivor, tag });
        } else {
          // Leaf bookmark: can remove directly.
          await removeBookmark(cid);
        }
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
