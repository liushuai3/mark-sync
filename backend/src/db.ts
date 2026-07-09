import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

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
  last_used_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON api_tokens(token_hash);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  parent_id TEXT,
  root TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  path TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  date_added INTEGER,
  date_modified INTEGER,
  deleted_at INTEGER,
  version INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_bookmarks_url ON bookmarks(user_id, url);
CREATE INDEX IF NOT EXISTS idx_bookmarks_path ON bookmarks(user_id, path);
CREATE INDEX IF NOT EXISTS idx_bookmarks_updated ON bookmarks(user_id, updated_at);

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
`;

db.exec(schema);

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
  path: string;
  position: number;
  date_added: number | null;
  date_modified: number | null;
  deleted_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
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

export function now(): number {
  return Date.now();
}
