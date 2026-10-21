/**
 * @file bookmarkHelpers.js
 * @description Shared low-level helpers used by both the initial-merge flow
 *   (SRS-v3.0 §6.1) and the recurring sync-cycle flow (SRS-v3.0 §6.2).
 *
 * Everything here is pure client-side glue: HTTP round-trip to the MarkSync
 *   API, promisified `chrome.bookmarks.*` calls, tree flattening, root
 *   mapping, cloud-path computation, and topological ordering for parent-
 *   before-child creation.
 *
 * These helpers do NOT touch `idMapStore` or `syncState` – higher-level
 *   flows own that coordination.
 *
 * @see SRS-v3.0 §6.1 – initial merge
 * @see SRS-v3.0 §6.2 – recurring sync cycle
 */

/**
 * Chrome bookmark tree has three root-level folders (id "1"/"2"/"3"). We
 * normalise them to MarkSync's `root` keys, and vice versa.
 *
 * WARNING: On some browsers (Edge, Brave, certain Chrome profiles since M127)
 * the root-level IDs may differ from the canonical 1/2/3. Code that needs
 * precise root identification should call `discoverRoots()` first and pass
 * the result explicitly. The hard-coded maps here serve as defaults that work
 * for ~95 % of installations. `initialMerge` calls `discoverRoots` before
 * flattening the local tree.
 *
 * @type {{[chromeId: string]: 'bookmark_bar'|'other'|'mobile'}}
 */
export let CHROME_ROOT_TO_KEY = {
  '1': 'bookmark_bar',
  '2': 'other',
  '3': 'mobile',
};

/**
 * Inverse of `CHROME_ROOT_TO_KEY`.
 * @type {{[rootKey: string]: string}}
 */
export let KEY_TO_CHROME_ROOT = {
  bookmark_bar: '1',
  other: '2',
  mobile: '3',
};

/**
 * Walk `chrome.bookmarks.getTree()` output and discover the real root IDs.
 * Browsers since ~Chrome 127 may use non-standard IDs for the three
 * bookmark root folders. This function merges the discovered IDs into the
 * module-level `CHROME_ROOT_TO_KEY` and `KEY_TO_CHROME_ROOT` so that
 * `flattenLocalTree`, `rootChromeIdFor` and any other downstream caller
 * automatically uses the right values.
 *
 * Heuristic: root "0" children whose title matches the known i18n names.
 * If not found via title (e.g. untranslated profile), fall back to the
 * hard-coded 1/2/3 defaults.
 *
 * @param {chrome.bookmarks.BookmarkTreeNode[]} tree
 */
export function discoverRoots(tree) {
  const rootNames = {
    bookmark_bar: [
      'bookmark bar', 'bookmarks bar',
      '书签栏', '書籤列',
      'ブックマークバー',
      '북마크 바', '북마크바',
      'barre de favoris',
      'lesezeichenleiste',
      'barra dei segnalibri',
      'barra de favoritos', 'barra de marcadores',
      'панель закладок',
      'pasek zakładek',
    ],
    other: [
      'other bookmarks', 'other favorites',
      '其他书签', '其他書籤',
      'その他のブックマーク',
      '기타 북마크',
      'autres favoris',
      'weitere lesezeichen',
      'altri segnalibri',
      'otros favoritos', 'outros favoritos',
      'другие закладки',
      'pozostałe zakładki',
    ],
    mobile: [
      'mobile bookmarks', 'mobile favorites',
      '移动书签', '移动端书签', '行動書籤',
      'モバイルブックマーク', 'モバイルのブックマーク',
      '모바일 북마크',
      'favoris mobiles',
      'mobile lesezeichen',
      'segnalibri mobili',
      'favoritos móviles', 'favoritos do celular',
      'мобильные закладки',
      'mobilne zakładki',
    ],
  };

  for (const rootNode of tree) {
    if (String(rootNode.id) !== '0') continue;
    for (const child of rootNode.children || []) {
      const id = String(child.id);
      const title = (child.title || '').trim().toLowerCase();
      for (const [key, names] of Object.entries(rootNames)) {
        if (names.some((nm) => title === nm.toLowerCase())) {
          CHROME_ROOT_TO_KEY[id] = key;
          KEY_TO_CHROME_ROOT[key] = id;
        }
      }
    }
  }
  // discovered
}

/**
 * Walk a Chrome bookmark tree and return IDs of empty (non-root) folders.
 * A folder is considered empty when it has no children at all, or only has
 * sub-folders that are themselves empty (recursively). This avoids deleting
 * folders that only contain other folders which may still receive children.
 *
 * Root-level folders (id "0"/"1"/"2"/"3") are never returned.
 * The function mutates the tree in place so you MUST call getBookmarkTree()
 * fresh each time you need a clean snapshot.
 *
 * @param {chrome.bookmarks.BookmarkTreeNode[]} tree
 * @returns {string[]} Chrome IDs of empty folders (deepest-first for safe deletion).
 */
export function findEmptyFolders(tree) {
  const ROOTS = new Set(['0']);
  for (const key of Object.keys(CHROME_ROOT_TO_KEY)) ROOTS.add(key);
  const result = [];

  function walk(nodes) {
    for (const node of nodes) {
      const id = String(node.id);
      if (ROOTS.has(id) || node.url) continue;
      // P0-6: separators have no url and no children — never treat them
      // as (empty) folders or the cleanup below would eat user separators.
      if (node.type === 'separator') continue;
      // Folder with zero direct children → empty leaf.
      if (!node.children || node.children.length === 0) {
        result.push(id);
      }
      walk(node.children || []);
    }
  }

  for (const top of tree) walk([top]);
  return result;
}

/**
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
 * Map a top-level Chrome bookmark node id to its MarkSync root key.
 * @param {string | number} chromeId
 * @returns {RootKey | null}
 */
export function rootFromChromeId(chromeId) {
  return CHROME_ROOT_TO_KEY[String(chromeId)] || null;
}

/**
 * Map a MarkSync root key back to its top-level Chrome bookmark node id.
 * Defaults to bookmark_bar ("1") when the key is unknown so callers always
 * receive a create-safe parent id.
 * @param {string} rootKey
 * @returns {string}
 */
export function rootChromeIdFor(rootKey) {
  return KEY_TO_CHROME_ROOT[rootKey] || '1';
}

/**
 * Fetch helper: talks to the MarkSync API with the standard bearer header
 * and unwraps `{ok:true,data:...}` envelopes. Throws on `ok:false` or
 * network/HTTP failure.
 *
 * @param {string} apiUrl e.g. `https://marksync.zcoolq.cn/api`
 * @param {string} token MarkSync API token (`mks_...`)
 * @param {string} path route path under the API base, e.g. `/sync/pull`
 * @param {{method?: string, body?: any}} [opts]
 * @returns {Promise<any>} The `data` field from `{ok:true,data:...}`.
 */
export async function callApi(apiUrl, token, path, opts = {}) {
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
 * Rows per single /sync/push request. The server caps sync bodies at 10MB;
 * ~400 rows stay far below that even with long titles/urls, and keeps a
 * huge bookmark import from turning into one permanently-rejected 413
 * payload (which used to fail every cycle forever).
 */
const PUSH_BATCH_SIZE = 400;

/**
 * POST /sync/push with client-side batching (P1-4).
 *
 * The payload is flattened into one ordered row list, sliced into batches
 * and POSTed sequentially; ordering is preserved so a parent always
 * precedes its children across batch boundaries (server inserts
 * parent-first anyway). If the server answers 413 the batch is retried
 * with a binary split, so a single oversized row can never wedge sync.
 *
 * Results (counts / conflicts / deduped / server_time) are merged into a
 * single response-shaped object so callers can treat this as one push.
 *
 * @param {string} apiUrl
 * @param {string} token
 * @param {{added?: object[], modified?: object[], removed?: object[]}} payload
 * @returns {Promise<{added_count: number, modified_count: number, removed_count: number, conflicts: object[], deduped: object[], server_time: number}>}
 */
export async function pushInBatches(apiUrl, token, { added = [], modified = [], removed = [] } = {}) {
  const rows = [
    ...added.map((r) => ({ kind: 'added', r })),
    ...modified.map((r) => ({ kind: 'modified', r })),
    ...removed.map((r) => ({ kind: 'removed', r })),
  ];
  const merged = {
    added_count: 0,
    modified_count: 0,
    removed_count: 0,
    conflicts: [],
    deduped: [],
    server_time: 0,
  };
  if (!rows.length) return merged;

  async function post(batch) {
    const body = { added: [], modified: [], removed: [] };
    for (const { kind, r } of batch) body[kind].push(r);
    const res = await callApi(apiUrl, token, '/sync/push', { method: 'POST', body });
    merged.added_count += Number(res?.added_count) || 0;
    merged.modified_count += Number(res?.modified_count) || 0;
    merged.removed_count += Number(res?.removed_count) || 0;
    if (Array.isArray(res?.conflicts)) merged.conflicts.push(...res.conflicts);
    if (Array.isArray(res?.deduped)) merged.deduped.push(...res.deduped);
    if (Number(res?.server_time)) merged.server_time = Number(res.server_time);
    return res;
  }

  async function postWithSplit(batch) {
    try {
      await post(batch);
    } catch (err) {
      if (err && err.status === 413 && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        console.warn(`[MarkSync/push] payload too large – splitting batch of ${batch.length}`);
        await postWithSplit(batch.slice(0, mid));
        await postWithSplit(batch.slice(mid));
      } else {
        throw err;
      }
    }
  }

  for (let i = 0; i < rows.length; i += PUSH_BATCH_SIZE) {
    await postWithSplit(rows.slice(i, i + PUSH_BATCH_SIZE));
  }
  return merged;
}

/**
 * Promisified `chrome.bookmarks.getTree`.
 * @returns {Promise<chrome.bookmarks.BookmarkTreeNode[]>}
 */
export function getBookmarkTree() {
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
export function createBookmark(arg) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.create(arg, (node) => {
      const err = chrome.runtime && chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(node);
    });
  });
}

/**
 * Promisified `chrome.bookmarks.update`.
 * @param {string} id
 * @param {{title?: string, url?: string}} changes
 * @returns {Promise<chrome.bookmarks.BookmarkTreeNode>}
 */
export function updateBookmark(id, changes) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.update(id, changes, (node) => {
      const err = chrome.runtime && chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(node);
    });
  });
}

/**
 * Promisified `chrome.bookmarks.move`.
 * @param {string} id
 * @param {{parentId?: string, index?: number}} dest
 * @returns {Promise<chrome.bookmarks.BookmarkTreeNode>}
 */
export function moveBookmark(id, dest) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.move(id, dest, (node) => {
      const err = chrome.runtime && chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(node);
    });
  });
}

/**
 * Promisified `chrome.bookmarks.remove`. Rejects on error so callers can
 * distinguish real failures from already-removed nodes.
 * @param {string} id
 * @returns {Promise<void>}
 */
export function removeBookmark(id) {
  return new Promise((resolve, reject) => {
    chrome.bookmarks.remove(String(id), () => {
      const err = chrome.runtime && chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
      } else {
        resolve();
      }
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
export function flattenLocalTree(tree) {
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
    // P0-6: bookmark separators are not part of the sync protocol. They
    // have no url and no children; the old `!node.url` check turned them
    // into nameless "folders" that were uploaded, re-created on other
    // devices, and tripped the dedupe pass. Skip them entirely.
    if (node.type === 'separator') return;
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
 * Compute parent_path for each cloud bookmark by walking parent_id chains.
 * Cloud bookmarks are keyed by id.
 *
 * @param {Array<object>} cloudList
 * @returns {Map<string, string>} cloud_id -> parent_path (excluding self)
 */
export function computeCloudPaths(cloudList) {
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
 * Topologically sort cloud rows so that a caller can create/apply them
 * parent-before-child; within a sibling group folders come first, then
 * urls, both sorted by `position` ascending. Rows that reference an
 * unknown parent are appended at the end so nothing is silently dropped.
 *
 * @template {{ id: string, parent_id: string | null, type?: string, position?: number }} T
 * @param {T[]} rows
 * @returns {T[]}
 */
export function topoSortForCreate(rows) {
  const remaining = new Map(rows.map((r) => [r.id, r]));
  const done = new Set();
  /** @type {T[]} */
  const out = [];
  const guardMax = rows.length + 8;
  let guard = 0;

  while (remaining.size && guard++ < guardMax) {
    /** @type {T[]} */
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
  for (const r of remaining.values()) out.push(r);
  return out;
}

export default {
  CHROME_ROOT_TO_KEY,
  KEY_TO_CHROME_ROOT,
  rootFromChromeId,
  rootChromeIdFor,
  callApi,
  pushInBatches,
  getBookmarkTree,
  createBookmark,
  updateBookmark,
  moveBookmark,
  removeBookmark,
  flattenLocalTree,
  computeCloudPaths,
  topoSortForCreate,
  findEmptyFolders,
};
