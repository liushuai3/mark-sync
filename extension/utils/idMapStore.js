/**
 * @file idMapStore.js
 * @description Client-side idMap store persisted in `chrome.storage.local`
 *   under the key `marksync_id_map`. Maintains a bidirectional mapping
 *   between MarkSync cloud IDs and Chrome bookmark IDs, plus lightweight
 *   metadata used by sync/reconciliation flows.
 *
 * Storage key: `marksync_id_map`
 * Value shape (SRS-v3.0 §5.1.1):
 * {
 *   [cloud_id]: {
 *     cloud_id: string,
 *     chrome_id: string,
 *     parent_cloud_id: string | null,
 *     name: string,
 *     url: string | null,
 *     type: 'folder' | 'url',
 *     root: 'bookmark_bar' | 'other' | 'mobile',
 *     position: number,
 *     date_modified: number,
 *     synced_at: number
 *   }
 * }
 *
 * Design notes:
 *  - Lazy-loaded: the first `get*`/`set`/`delete`/`all`/`size` call awaits
 *    an initial `load()`. All subsequent reads are synchronous against the
 *    in-memory cache.
 *  - Writes stay in memory until `save()` is called explicitly. This keeps
 *    bulk sync operations O(1) per mutation and lets the caller batch a
 *    single atomic write.
 *  - A `chrome_id -> cloud_id` reverse index is kept in sync on every
 *    mutation.
 *  - No external dependencies; pure client JS, `async/await` only.
 *
 * @see SRS-v3.0 §5.1.1 – client id map
 */

const STORAGE_KEY = 'marksync_id_map';

/** @type {Object<string, object> | null} In-memory cache; null until loaded. */
let cache = null;

/** @type {Map<string, string>} chrome_id -> cloud_id reverse index. */
let reverseIndex = new Map();

/** @type {Promise<void> | null} In-flight load promise for concurrency. */
let loadPromise = null;

/**
 * Read the raw map object from `chrome.storage.local`.
 * @returns {Promise<Object<string, object>>}
 */
function readStorage() {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        const val = result && result[STORAGE_KEY];
        resolve(val && typeof val === 'object' ? val : {});
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Write the given map object atomically to `chrome.storage.local`.
 * @param {Object<string, object>} value
 * @returns {Promise<void>}
 */
function writeStorage(value) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: value }, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Rebuild the chrome_id -> cloud_id reverse index from the current cache.
 * @returns {void}
 */
function rebuildReverseIndex() {
  reverseIndex = new Map();
  if (!cache) return;
  for (const cloudId of Object.keys(cache)) {
    const entry = cache[cloudId];
    if (entry && entry.chrome_id != null) {
      reverseIndex.set(String(entry.chrome_id), cloudId);
    }
  }
}

/**
 * Ensure the in-memory cache has been loaded from storage.
 * Safe for concurrent callers – all wait on the same promise.
 * @returns {Promise<void>}
 */
async function ensureLoaded() {
  if (cache !== null) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      const raw = await readStorage();
      cache = raw;
      rebuildReverseIndex();
    })();
  }
  try {
    await loadPromise;
  } finally {
    loadPromise = null;
  }
}

/**
 * Force-load (or reload) the idMap from `chrome.storage.local` into memory.
 * Overwrites any unsaved in-memory changes.
 * @returns {Promise<void>}
 */
export async function load() {
  const raw = await readStorage();
  cache = raw;
  rebuildReverseIndex();
}

/**
 * Persist the current in-memory idMap to `chrome.storage.local` in a single
 * atomic write. If nothing has been loaded yet, this is a no-op.
 * @returns {Promise<void>}
 */
export async function save() {
  if (cache === null) return;
  await writeStorage(cache);
}

/**
 * Look up an entry by its MarkSync cloud id.
 * @param {string} cloudId
 * @returns {Promise<object | undefined>}
 */
export async function getByCloudId(cloudId) {
  await ensureLoaded();
  if (cloudId == null) return undefined;
  return cache[cloudId];
}

/**
 * Look up an entry by its Chrome bookmark id via the reverse index.
 * @param {string} chromeId
 * @returns {Promise<object | undefined>}
 */
export async function getByChromeId(chromeId) {
  await ensureLoaded();
  if (chromeId == null) return undefined;
  const cloudId = reverseIndex.get(String(chromeId));
  return cloudId ? cache[cloudId] : undefined;
}

/**
 * Insert or replace an entry keyed by `cloudId`. Updates the reverse index.
 * The entry is stored as-is (shallow-copied) so callers can safely mutate
 * their local object afterwards.
 * @param {string} cloudId
 * @param {object} entry
 * @returns {Promise<void>}
 */
export async function set(cloudId, entry) {
  await ensureLoaded();
  if (!cloudId) throw new Error('idMapStore.set: cloudId is required');
  if (!entry || typeof entry !== 'object') {
    throw new Error('idMapStore.set: entry must be an object');
  }

  // If replacing an existing entry whose chrome_id changed, clean the old
  // reverse-index mapping to avoid stale pointers.
  const prev = cache[cloudId];
  if (prev && prev.chrome_id != null && prev.chrome_id !== entry.chrome_id) {
    const prevChromeId = String(prev.chrome_id);
    if (reverseIndex.get(prevChromeId) === cloudId) {
      reverseIndex.delete(prevChromeId);
    }
  }

  const copy = { ...entry, cloud_id: cloudId };
  cache[cloudId] = copy;
  if (copy.chrome_id != null) {
    reverseIndex.set(String(copy.chrome_id), cloudId);
  }
}

/**
 * Remove the entry with the given cloud id, if present.
 * @param {string} cloudId
 * @returns {Promise<boolean>} True when an entry was removed.
 */
export async function del(cloudId) {
  await ensureLoaded();
  const entry = cache[cloudId];
  if (!entry) return false;
  if (entry.chrome_id != null) {
    const chromeId = String(entry.chrome_id);
    if (reverseIndex.get(chromeId) === cloudId) {
      reverseIndex.delete(chromeId);
    }
  }
  delete cache[cloudId];
  return true;
}

// `delete` is a reserved word for module exports in some tool chains but is
// legal in ES2022+. Export both names for ergonomic call-sites.
export { del as delete };

/**
 * Remove the entry associated with the given Chrome bookmark id, if any.
 * @param {string} chromeId
 * @returns {Promise<boolean>} True when an entry was removed.
 */
export async function deleteByChromeId(chromeId) {
  await ensureLoaded();
  if (chromeId == null) return false;
  const cloudId = reverseIndex.get(String(chromeId));
  if (!cloudId) return false;
  return del(cloudId);
}

/**
 * Get all entries as an array (order not guaranteed).
 * @returns {Promise<object[]>}
 */
export async function all() {
  await ensureLoaded();
  return Object.values(cache);
}

/**
 * @returns {Promise<number>} Number of entries in the map.
 */
export async function size() {
  await ensureLoaded();
  return Object.keys(cache).length;
}

/**
 * Empty the map in memory and persist the empty object to storage.
 * @returns {Promise<void>}
 */
export async function clear() {
  cache = {};
  reverseIndex = new Map();
  await writeStorage(cache);
}

/**
 * Capture a shallow copy of the current in-memory idMap (P0 rollback fix).
 * `syncCycle` snapshots BEFORE the diff phase and restores it when the push
 * round-trip fails — otherwise the diff's baseline rewrites would claim the
 * local changes were already synced and they would NEVER be pushed again
 * (silent divergence between this device and the cloud).
 *
 * Shallow copy is safe: every mutation path (`set`/`del`) replaces entry
 * objects with new copies instead of mutating them in place.
 * @returns {Object<string, object> | null}  null when nothing is loaded yet.
 */
export function snapshot() {
  return cache === null ? null : { ...cache };
}

/**
 * Restore a snapshot taken by snapshot() and rebuild the reverse index.
 * No-op when the snapshot is null. Callers must re-issue save() themselves
 * if the restored state should also hit disk.
 * @param {Object<string, object> | null} snap
 */
export function restore(snap) {
  if (!snap) return;
  cache = { ...snap };
  rebuildReverseIndex();
}

/**
 * @internal Test-only helper: drop the in-memory cache without touching
 *   storage, forcing the next call to reload from `chrome.storage.local`.
 *   Not part of the public API contract in SRS §5.1.1.
 * @returns {void}
 */
export function _resetForTest() {
  cache = null;
  reverseIndex = new Map();
  loadPromise = null;
}

export default {
  load,
  save,
  snapshot,
  restore,
  getByCloudId,
  getByChromeId,
  set,
  delete: del,
  deleteByChromeId,
  all,
  size,
  clear,
};
