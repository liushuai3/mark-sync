/**
 * @file syncState.js
 * @description Wrapper around `chrome.storage.local` key `marksync_state`,
 *   which tracks high-level sync progress and error metadata used by
 *   pull/push flows and the popup UI.
 *
 * Storage key: `marksync_state`
 * Value shape (SRS-v3.0 §5.1.2):
 * {
 *   last_pulled_at:     number,   // epoch ms of last successful pull
 *   last_sync_at:       number,   // epoch ms of last successful sync (pull+push)
 *   last_error:         string | null, // last error message, if any
 *   last_conflicts:     number,   // number of conflicts in the last sync
 *   initial_merge_done: boolean   // true once first-run merge completed
 * }
 *
 * All setters are merge-writes: `update({...partial})` reads the current
 * value, shallow-merges the patch, and writes it back in one call. Callers
 * should not assume atomicity across multiple `update()` calls; each call is
 * independent.
 *
 * @see SRS-v3.0 §5.1.2 – client sync state
 */

const STORAGE_KEY = 'marksync_state';

/**
 * @returns {object} A fresh copy of the default state.
 */
function defaults() {
  return {
    last_pulled_at: 0,
    last_sync_at: 0,
    last_error: null,
    last_conflicts: 0,
    initial_merge_done: false,
  };
}

/**
 * Read the raw state value from `chrome.storage.local`.
 * @returns {Promise<object | undefined>}
 */
function readStorage() {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result ? result[STORAGE_KEY] : undefined);
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Write the given state object to `chrome.storage.local`.
 * @param {object} value
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
 * Get the full sync-state object, filling in defaults for any missing keys.
 * @returns {Promise<object>}
 */
export async function get() {
  const raw = await readStorage();
  return { ...defaults(), ...(raw && typeof raw === 'object' ? raw : {}) };
}

/**
 * Merge `partial` into the current state and persist. Unknown keys are
 * accepted so callers can extend state without a schema round-trip, but
 * prefer sticking to the shape documented in SRS §5.1.2.
 * @param {object} partial
 * @returns {Promise<object>} The updated state after the write.
 */
export async function update(partial) {
  if (!partial || typeof partial !== 'object') {
    throw new Error('syncState.update: partial must be an object');
  }
  const current = await get();
  const next = { ...current, ...partial };
  await writeStorage(next);
  return next;
}

/**
 * Reset the sync state to its documented defaults and persist.
 * @returns {Promise<object>} The default state, after the write.
 */
export async function reset() {
  const value = defaults();
  await writeStorage(value);
  return value;
}

export default { get, update, reset };
