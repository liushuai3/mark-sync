import { db, now, type Backup, type BackupConfig, type Bookmark } from '../db.js';
import { config } from '../config.js';
import { logger } from './logger.js';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

const BACKUP_ROOT = config.backupDir;

function userDir(userId: number): string {
  const dir = join(BACKUP_ROOT, String(userId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

const selectActiveBookmarks = db.prepare<[number], Bookmark>(
  'SELECT * FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL ORDER BY root, position, name'
);
const selectAllBookmarksAny = db.prepare<[number], Bookmark>(
  'SELECT * FROM bookmarks WHERE user_id = ? ORDER BY root, position, name'
);
const insertBackup = db.prepare(
  'INSERT INTO backups (user_id, name, kind, size, bookmark_count, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const listBackupsStmt = db.prepare<[number], Backup>(
  'SELECT * FROM backups WHERE user_id = ? ORDER BY created_at DESC'
);
const getBackupStmt = db.prepare<[number, number], Backup>(
  'SELECT * FROM backups WHERE id = ? AND user_id = ? LIMIT 1'
);
const deleteBackupStmt = db.prepare(
  'DELETE FROM backups WHERE id = ? AND user_id = ?'
);
const getConfigStmt = db.prepare<[number], BackupConfig>(
  'SELECT * FROM backup_configs WHERE user_id = ?'
);
const upsertConfigStmt = db.prepare(
  `INSERT INTO backup_configs (user_id, enabled, interval_hours, hour_of_day, keep_count, last_run_at, next_run_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(user_id) DO UPDATE SET
     enabled = excluded.enabled,
     interval_hours = excluded.interval_hours,
     hour_of_day = excluded.hour_of_day,
     keep_count = excluded.keep_count,
     next_run_at = excluded.next_run_at,
     updated_at = excluded.updated_at`
);
const updateConfigRunStmt = db.prepare(
  'UPDATE backup_configs SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE user_id = ?'
);
const listEnabledConfigs = db.prepare<[], BackupConfig>(
  'SELECT * FROM backup_configs WHERE enabled = 1'
);
const insertRestoredBookmark = db.prepare(
  `INSERT INTO bookmarks (id, user_id, type, parent_id, root, name, url, position, date_added, date_modified, server_updated_at, deleted_at, version, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
);
const softDeleteAll = db.prepare(
  'UPDATE bookmarks SET deleted_at = ?, server_updated_at = ?, version = version + 1 WHERE user_id = ? AND deleted_at IS NULL'
);
// Suppress unused warning; kept for future "restore into existing" mode.
void softDeleteAll;
const purgeUserBookmarks = db.prepare('DELETE FROM bookmarks WHERE user_id = ?');

export interface CreateBackupOptions {
  userId: number;
  name?: string;
  kind?: 'manual' | 'scheduled';
}

export function createBackup(opts: CreateBackupOptions): Backup {
  const { userId, kind = 'manual' } = opts;
  const bookmarks = selectAllBookmarksAny.all(userId);
  const activeCount = bookmarks.filter((b) => b.deleted_at == null).length;
  const dir = userDir(userId);
  const ts = now();
  const stamp = new Date(ts).toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${stamp}.json.gz`;
  const filePath = join(dir, filename);
  const payload = {
    schema: 'marksync-backup/v1',
    user_id: userId,
    created_at: ts,
    bookmarks,
  };
  const buf = gzipSync(Buffer.from(JSON.stringify(payload)));
  writeFileSync(filePath, buf);
  const name = opts.name || (kind === 'scheduled' ? '自动备份' : '手动备份');
  const info = insertBackup.run(userId, name, kind, buf.length, activeCount, filePath, ts);
  const row = getBackupStmt.get(Number(info.lastInsertRowid), userId)!;
  return row;
}

export function listBackups(userId: number): Backup[] {
  return listBackupsStmt.all(userId);
}

export function deleteBackup(userId: number, id: number): boolean {
  const row = getBackupStmt.get(id, userId);
  if (!row) return false;
  try {
    if (existsSync(row.file_path)) unlinkSync(row.file_path);
  } catch (err) {
    logger.warn('unlink backup file failed', err);
  }
  deleteBackupStmt.run(id, userId);
  return true;
}

export interface RestoreResult {
  restored: number;
  cleared: number;
}

export function restoreBackup(userId: number, id: number): RestoreResult {
  const row = getBackupStmt.get(id, userId);
  if (!row) throw new Error('Backup not found');
  if (!existsSync(row.file_path)) throw new Error('Backup file missing on disk');
  const raw = gunzipSync(readFileSync(row.file_path)).toString('utf8');
  const payload = JSON.parse(raw);
  if (!Array.isArray(payload?.bookmarks)) throw new Error('Invalid backup file');
  const bookmarks: Bookmark[] = payload.bookmarks;

  // Count only active (non-deleted) bookmarks for user-facing message.
  // The DB row count and file record count differ because tombstones are stored
  // to preserve sync semantics but shouldn't be counted as user data.
  const activeCount = bookmarks.filter((b) => b.deleted_at == null).length;

  const ts = now();
  let restored = 0;
  const tx = db.transaction(() => {
    // Wipe existing bookmarks (hard delete so ids match)
    purgeUserBookmarks.run(userId);
    for (const b of bookmarks) {
      insertRestoredBookmark.run(
        b.id,
        userId,
        b.type,
        b.parent_id ?? null,
        b.root,
        b.name,
        b.url ?? null,
        b.position ?? 0,
        b.date_added ?? ts,
        b.date_modified ?? null,
        ts, // server_updated_at
        b.deleted_at ?? null,
        ts
      );
      restored++;
    }
  });
  tx();
  return { restored: activeCount, cleared: bookmarks.length };
}

export function getBackupConfig(userId: number): BackupConfig {
  const existing = getConfigStmt.get(userId);
  if (existing) return existing;
  const ts = now();
  upsertConfigStmt.run(userId, 0, 24, 3, 10, null, null, ts);
  return getConfigStmt.get(userId)!;
}

export interface UpdateConfigInput {
  enabled?: boolean;
  interval_hours?: number;
  hour_of_day?: number;
  keep_count?: number;
}

export function updateBackupConfig(userId: number, input: UpdateConfigInput): BackupConfig {
  const current = getBackupConfig(userId);
  const enabled = input.enabled ?? Boolean(current.enabled);
  const intervalHours = Math.max(
    1,
    Math.min(24 * 30, input.interval_hours ?? current.interval_hours)
  );
  const hourOfDay = Math.max(0, Math.min(23, input.hour_of_day ?? current.hour_of_day));
  const keepCount = Math.max(1, Math.min(100, input.keep_count ?? current.keep_count));
  const ts = now();
  const nextRun = enabled ? computeNextRun(ts, intervalHours, hourOfDay) : null;
  logger.info(`[backup] next_run computed: interval=${intervalHours}h, anchor=${hourOfDay}:00, next=${new Date(nextRun || 0).toISOString()}, now=${new Date(ts).toISOString()}`);
  upsertConfigStmt.run(
    userId,
    enabled ? 1 : 0,
    intervalHours,
    hourOfDay,
    keepCount,
    current.last_run_at ?? null,
    nextRun,
    ts
  );
  return getConfigStmt.get(userId)!;
}

function computeNextRun(fromMs: number, intervalHours: number, hourOfDay: number): number {
  // Compute next scheduled backup based on interval and anchor hour.
  // If interval is 24h, it's "daily at hourOfDay".
  // If interval is other (e.g. 12h), it rolls every intervalHours starting from hourOfDay.
  const now = new Date(fromMs);
  
  // Build candidate: today at hourOfDay, same minute/second zeroed
  const candidate = new Date(now);
  candidate.setHours(hourOfDay, 0, 0, 0);
  
  // If candidate is in the past (or now), advance by intervalHours
  // Keep advancing until we're in the future
  let next = candidate.getTime();
  while (next <= fromMs) {
    next += intervalHours * 3600_000;
  }
  return next;
}

export function pruneOldBackups(userId: number, keepCount: number): number {
  const all = listBackupsStmt.all(userId);
  if (all.length <= keepCount) return 0;
  const toDelete = all.slice(keepCount);
  let removed = 0;
  for (const b of toDelete) {
    if (deleteBackup(userId, b.id)) removed++;
  }
  return removed;
}

/**
 * Ticker: check every minute for enabled configs whose next_run_at has passed.
 */
export function startBackupScheduler() {
  mkdirSync(BACKUP_ROOT, { recursive: true });
  const tick = () => {
    const nowMs = now();
    const configs = listEnabledConfigs.all();
    for (const cfg of configs) {
      if (!cfg.next_run_at || cfg.next_run_at > nowMs) continue;
      try {
        const backup = createBackup({ userId: cfg.user_id, kind: 'scheduled' });
        pruneOldBackups(cfg.user_id, cfg.keep_count);
        const nextRun = computeNextRun(nowMs, cfg.interval_hours, cfg.hour_of_day);
        updateConfigRunStmt.run(nowMs, nextRun, nowMs, cfg.user_id);
        logger.info(
          `Scheduled backup for user=${cfg.user_id} id=${backup.id} size=${backup.size}`
        );
      } catch (err) {
        logger.error('scheduled backup failed', err);
      }
    }
  };
  // Run every 60 seconds, first tick 30s after boot.
  setTimeout(tick, 30_000);
  setInterval(tick, 60_000);
  logger.info('Backup scheduler started');
}

export function readBackupFile(userId: number, id: number): { name: string; buffer: Buffer } | null {
  const row = getBackupStmt.get(id, userId);
  if (!row || !existsSync(row.file_path)) return null;
  return { name: `marksync-backup-${id}.json.gz`, buffer: readFileSync(row.file_path) };
}
