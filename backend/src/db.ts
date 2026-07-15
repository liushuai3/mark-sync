import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ─── v3.0 migration: drop legacy bookmarks table ──────────────────────
// SRS §11.3 explicitly allows wiping bookmarks. Detect the legacy schema
// (has `path` column or lacks `server_updated_at`) and drop it before the
// CREATE TABLE below re-materialises the v3.0 shape.
try {
  const cols = db.prepare(`PRAGMA table_info(bookmarks)`).all() as Array<{ name: string }>;
  if (cols.length > 0) {
    const hasPath = cols.some((c) => c.name === 'path');
    const hasServerUpdatedAt = cols.some((c) => c.name === 'server_updated_at');
    if (hasPath || !hasServerUpdatedAt) {
      db.exec('DROP TABLE IF EXISTS bookmarks');
      // eslint-disable-next-line no-console
      console.log('[migration] Dropped legacy bookmarks table for v3.0');
    }
  }
} catch {
  // best-effort: if PRAGMA fails, CREATE TABLE below will still run
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  token_prefix TEXT NOT NULL,
  token_encrypted TEXT,
  last_used_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON api_tokens(token_hash);

-- v3.0 bookmarks table (SRS 5.2). 'path' is derived from parent_id chain
-- and no longer stored. 'server_updated_at' is the pull 'since' baseline.
CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  parent_id TEXT,
  root TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  date_added INTEGER,
  date_modified INTEGER,
  server_updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user_updated ON bookmarks(user_id, server_updated_at);
CREATE INDEX IF NOT EXISTS idx_bookmarks_parent ON bookmarks(parent_id);

CREATE TABLE IF NOT EXISTS sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id INTEGER REFERENCES api_tokens(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  added_count INTEGER DEFAULT 0,
  removed_count INTEGER DEFAULT 0,
  modified_count INTEGER DEFAULT 0,
  device_info TEXT,
  ip TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_synclogs_user ON sync_logs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  bookmark_count INTEGER NOT NULL DEFAULT 0,
  file_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_user ON backups(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backup_configs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  interval_hours INTEGER NOT NULL DEFAULT 24,
  hour_of_day INTEGER NOT NULL DEFAULT 3,
  keep_count INTEGER NOT NULL DEFAULT 10,
  last_run_at INTEGER,
  next_run_at INTEGER,
  updated_at INTEGER NOT NULL
);
`;

db.exec(schema);

// ─── Lightweight migrations for pre-existing databases ────────────────
function ensureColumn(table: string, column: string, defSql: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${defSql}`);
  }
}
ensureColumn('api_tokens', 'token_encrypted', 'TEXT');

// ─── System settings (global toggles like registration) ──────────────
db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
)`);

export type User = {
  id: number;
  username: string;
  email: string | null;
  password_hash: string;
  is_admin: number;
  created_at: number;
  updated_at: number;
};

export type ApiToken = {
  id: number;
  user_id: number;
  name: string;
  token_hash: string;
  token_prefix: string;
  token_encrypted: string | null;
  last_used_at: number | null;
  expires_at: number | null;
  created_at: number;
  revoked_at: number | null;
};

export type Bookmark = {
  id: string;
  user_id: number;
  type: 'folder' | 'url';
  parent_id: string | null;
  root: 'bookmark_bar' | 'other' | 'mobile';
  name: string;
  url: string | null;
  position: number;
  date_added: number | null;
  date_modified: number | null;
  server_updated_at: number;
  deleted_at: number | null;
  version: number;
  created_at: number;
};

export type SyncLog = {
  id: number;
  user_id: number;
  token_id: number | null;
  action: string;
  added_count: number;
  removed_count: number;
  modified_count: number;
  device_info: string | null;
  ip: string | null;
  duration_ms: number | null;
  created_at: number;
};

export type Backup = {
  id: number;
  user_id: number;
  name: string;
  kind: 'manual' | 'scheduled';
  size: number;
  bookmark_count: number;
  file_path: string;
  created_at: number;
};

export type BackupConfig = {
  user_id: number;
  enabled: number;
  interval_hours: number;
  hour_of_day: number;
  keep_count: number;
  last_run_at: number | null;
  next_run_at: number | null;
  updated_at: number;
};

export function now(): number {
  return Date.now();
}
