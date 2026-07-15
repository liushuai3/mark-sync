// Tombstone cleanup — SRS §5.3.
// Deletes soft-deleted bookmarks older than the retention window.
import { db, now } from '../db.js';
import { logger } from './logger.js';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // every 24h

const deleteOldTombstones = db.prepare(
  'DELETE FROM bookmarks WHERE deleted_at IS NOT NULL AND deleted_at < ?'
);

export function runTombstoneCleanupOnce(): number {
  const cutoff = now() - RETENTION_MS;
  try {
    const info = deleteOldTombstones.run(cutoff);
    if (info.changes > 0) {
      logger.info(`[tombstone] purged ${info.changes} rows (cutoff=${cutoff})`);
    }
    return info.changes as number;
  } catch (err) {
    logger.error('[tombstone] cleanup failed', err);
    return 0;
  }
}

/**
 * Start the tombstone cleanup interval. Runs once immediately, then every
 * `intervalMs` (default 24h). Returns the interval handle so callers can
 * `clearInterval` in tests.
 */
export function startTombstoneCleanup(
  intervalMs: number = DEFAULT_INTERVAL_MS
): NodeJS.Timeout {
  // Run once at startup so we don't wait a full day on a fresh boot
  runTombstoneCleanupOnce();
  const handle = setInterval(runTombstoneCleanupOnce, intervalMs);
  // Do not keep the event loop alive solely for cleanup
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}
