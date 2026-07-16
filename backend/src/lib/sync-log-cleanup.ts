// Sync log cleanup — keep last 10 days of sync_logs entries.
import { db, now } from '../db.js';
import { logger } from './logger.js';

const RETENTION_MS = 10 * 24 * 60 * 60 * 1000; // 10 days
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // every 24h

const deleteOldLogs = db.prepare(
  'DELETE FROM sync_logs WHERE created_at < ?'
);

export function runSyncLogCleanupOnce(): number {
  const cutoff = now() - RETENTION_MS;
  try {
    const info = deleteOldLogs.run(cutoff);
    if (info.changes > 0) {
      logger.info(`[sync-log] purged ${info.changes} rows (cutoff=${cutoff})`);
    }
    return info.changes as number;
  } catch (err) {
    logger.error('[sync-log] cleanup failed', err);
    return 0;
  }
}

/**
 * Start the sync-log cleanup interval. Runs once immediately, then every
 * `intervalMs` (default 24h). Returns the interval handle for test cleanup.
 */
export function startSyncLogCleanup(
  intervalMs: number = DEFAULT_INTERVAL_MS
): NodeJS.Timeout {
  runSyncLogCleanupOnce();
  const handle = setInterval(runSyncLogCleanupOnce, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}
