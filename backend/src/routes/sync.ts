// v3.0 sync API — LWW conflicts, incremental pull with tombstones,
// force overwrite. See docs/SRS-v3.0.md §6, §7, §8.
import { Hono } from 'hono';
import { z } from 'zod';
import { db, now, type Bookmark, type User, type ApiToken } from '../db.js';
import { requireApiToken } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';

const app = new Hono();
app.use('*', requireApiToken);

// ─── Constants ────────────────────────────────────────────────────────
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ─── Zod schemas (SRS §8.4 / §8.5) ────────────────────────────────────
const rootEnum = z.enum(['bookmark_bar', 'other', 'mobile']);
const typeEnum = z.enum(['folder', 'url']);

const bookmarkInput = z.object({
  id: z.string().min(1),
  type: typeEnum,
  parent_id: z.string().nullable().optional(),
  root: rootEnum,
  name: z.string(),
  url: z.string().nullable().optional(),
  position: z.number().int().optional(),
  date_added: z.number().nullable().optional(),
  date_modified: z.number().nullable().optional(),
});

const modifiedInput = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  url: z.string().nullable().optional(),
  parent_id: z.string().nullable().optional(),
  position: z.number().int().optional(),
  date_modified: z.number(), // ⭐ required, LWW baseline
});

const removedInput = z.object({
  id: z.string().min(1),
  date_modified: z.number(), // ⭐ required, deletion action time
});

const pushSchema = z.object({
  added: z.array(bookmarkInput).default([]),
  modified: z.array(modifiedInput).default([]),
  removed: z.array(removedInput).default([]),
});

const forceSchema = z.object({
  bookmarks: z.array(bookmarkInput),
});

// ─── Prepared statements ──────────────────────────────────────────────
const selectAllForPull = db.prepare<[number], Bookmark>(
  'SELECT * FROM bookmarks WHERE user_id = ? ORDER BY server_updated_at'
);
const selectSincePull = db.prepare<[number, number], Bookmark>(
  'SELECT * FROM bookmarks WHERE user_id = ? AND server_updated_at > ? ORDER BY server_updated_at'
);
const findById = db.prepare<[string, number], Bookmark>(
  'SELECT * FROM bookmarks WHERE id = ? AND user_id = ?'
);
// Content-based dedup: find an existing active bookmark with same root/parent/name/url.
// Used on push to prevent duplicate bookmarks from different browsers/devices.
const findDuplicate = db.prepare<
  [number, string, string, string, string],
  Bookmark
>(
  `SELECT * FROM bookmarks
    WHERE user_id = ? AND root = ?
      AND COALESCE(parent_id, '') = ?
      AND name = ? AND COALESCE(url, '') = ?
      AND deleted_at IS NULL
    LIMIT 1`
);
const insertBookmark = db.prepare(
  `INSERT INTO bookmarks
     (id, user_id, type, parent_id, root, name, url, position,
      date_added, date_modified, server_updated_at, deleted_at, version, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`
);
const softDeleteAllActive = db.prepare(
  `UPDATE bookmarks
      SET deleted_at = ?, server_updated_at = ?, version = version + 1
    WHERE user_id = ? AND deleted_at IS NULL`
);
const insertSyncLog = db.prepare(
  `INSERT INTO sync_logs
     (user_id, token_id, action, added_count, removed_count, modified_count,
      device_info, ip, duration_ms, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// ─── Helpers ──────────────────────────────────────────────────────────
type ClientMeta = { ip: string | null; ua: string | null };

function getClientMeta(c: any): ClientMeta {
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    c.req.header('x-real-ip') ||
    null;
  const ua = c.req.header('user-agent') || null;
  return { ip, ua };
}

/**
 * Strip server-only fields from a bookmark before returning to clients.
 * SRS §8.3: clients do not receive `server_updated_at` or internal columns.
 */
function toPullRow(b: Bookmark) {
  return {
    id: b.id,
    type: b.type,
    parent_id: b.parent_id,
    root: b.root,
    name: b.name,
    url: b.url,
    position: b.position,
    date_added: b.date_added,
    date_modified: b.date_modified,
    deleted_at: b.deleted_at,
    version: b.version,
  };
}

type Conflict = {
  id: string;
  reason: 'not_found' | 'already_deleted' | 'newer_exists';
  server_date_modified?: number;
};

// ─── 8.3 GET /api/sync/pull?since=<ms> ────────────────────────────────
app.get('/pull', (c) => {
  const start = Date.now();
  const user = c.get('user' as never) as User;
  const token = c.get('token' as never) as ApiToken | undefined;

  const sinceStr = c.req.query('since');
  const sinceRaw = sinceStr != null ? Number(sinceStr) : null;
  const sinceValid = sinceRaw != null && Number.isFinite(sinceRaw) && sinceRaw >= 0;
  const serverTime = now();

  // Full when since is missing/invalid or older than the tombstone window
  const full = !sinceValid || (sinceRaw as number) < serverTime - TOMBSTONE_RETENTION_MS;

  const rows = full
    ? selectAllForPull.all(user.id)
    : selectSincePull.all(user.id, sinceRaw as number);

  const bookmarks = rows.map(toPullRow);

  const { ip, ua } = getClientMeta(c);
  try {
    insertSyncLog.run(
      user.id,
      token?.id ?? null,
      'pull',
      0,
      0,
      0,
      ua,
      ip,
      Date.now() - start,
      now()
    );
  } catch (err) {
    logger.warn('sync_logs insert failed (pull)', err);
  }

  return c.json({
    ok: true,
    data: {
      bookmarks,
      server_time: serverTime,
      full,
    },
  });
});

// ─── 8.4 POST /api/sync/push ──────────────────────────────────────────
app.post('/push', async (c) => {
  const start = Date.now();
  const user = c.get('user' as never) as User;
  const token = c.get('token' as never) as ApiToken | undefined;

  const body = await c.req.json().catch(() => ({}));
  const parsed = pushSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' },
      400
    );
  }
  const { added, modified, removed } = parsed.data;

  let addedCount = 0;
  let modifiedCount = 0;
  let removedCount = 0;
  const conflicts: Conflict[] = [];
  /** Content-based dedup results returned to client for idMap correction. */
  const deduped: Array<{ requested_id: string; existing_id: string; name: string }> = [];

  const tx = db.transaction(() => {
    const ts = now();

    // ── added ────────────────────────────────────────────────────────
    for (const b of added) {
      // SRS §8.4: id 已存在（含墓碑）→ conflicts newer_exists
      const existing = findById.get(b.id, user.id);
      if (existing) {
        conflicts.push({ id: b.id, reason: 'newer_exists' });
        continue;
      }

      // Content-based dedup: check if an active bookmark with same
      // (root, parent_id, name, url) already exists. This prevents
      // duplicates when two browsers/devices push the same bookmark
      // under different client-generated UUIDs.
      const dup = findDuplicate.get(
        user.id,
        b.root,
        b.parent_id ?? '',
        b.name,
        b.url ?? ''
      );
      if (dup) {
        deduped.push({
          requested_id: b.id,
          existing_id: dup.id,
          name: b.name,
        });
        continue;
      }

      insertBookmark.run(
        b.id,
        user.id,
        b.type,
        b.parent_id ?? null,
        b.root,
        b.name,
        b.url ?? null,
        b.position ?? 0,
        b.date_added ?? ts,
        b.date_modified ?? ts,
        ts, // server_updated_at
        ts  // created_at
      );
      addedCount++;
    }

    // ── modified (LWW, SRS §7.2) ─────────────────────────────────────
    for (const m of modified) {
      const dbRow = findById.get(m.id, user.id);
      if (!dbRow) {
        conflicts.push({ id: m.id, reason: 'not_found' });
        continue;
      }
      if (dbRow.deleted_at != null) {
        // 删除赢
        conflicts.push({ id: m.id, reason: 'already_deleted' });
        continue;
      }
      const dbDm = dbRow.date_modified ?? 0;
      if (m.date_modified < dbDm) {
        conflicts.push({
          id: m.id,
          reason: 'newer_exists',
          server_date_modified: dbDm,
        });
        continue;
      }

      // Build partial update: only fields present in payload change.
      const nextName = m.name !== undefined ? m.name : dbRow.name;
      const nextUrl =
        m.url !== undefined ? m.url : dbRow.url;
      const nextParent =
        m.parent_id !== undefined ? m.parent_id : dbRow.parent_id;
      const nextPos =
        m.position !== undefined ? m.position : dbRow.position;

      db.prepare(
        `UPDATE bookmarks
            SET name = ?, url = ?, parent_id = ?, position = ?,
                date_modified = ?, server_updated_at = ?,
                version = version + 1
          WHERE id = ? AND user_id = ?`
      ).run(
        nextName,
        nextUrl,
        nextParent,
        nextPos,
        m.date_modified,
        ts,
        m.id,
        user.id
      );
      modifiedCount++;
    }

    // ── removed (SRS §7.2, 删除赢, 幂等) ─────────────────────────────
    for (const r of removed) {
      const dbRow = findById.get(r.id, user.id);
      if (!dbRow) continue; // 静默忽略（幂等）
      if (dbRow.deleted_at != null) continue; // 已墓碑
      db.prepare(
        `UPDATE bookmarks
            SET deleted_at = ?, date_modified = ?,
                server_updated_at = ?, version = version + 1
          WHERE id = ? AND user_id = ?`
      ).run(ts, r.date_modified, ts, r.id, user.id);
      removedCount++;
    }
  });

  try {
    tx();
  } catch (err) {
    logger.error('push transaction failed', err);
    return c.json(
      { ok: false, error: 'Transaction failed', code: 'SERVER_ERROR' },
      500
    );
  }

  const serverTime = now();
  const { ip, ua } = getClientMeta(c);
  try {
    insertSyncLog.run(
      user.id,
      token?.id ?? null,
      'push',
      addedCount,
      removedCount,
      modifiedCount,
      ua,
      ip,
      Date.now() - start,
      serverTime
    );
  } catch (err) {
    logger.warn('sync_logs insert failed (push)', err);
    // eslint-disable-next-line no-console
    console.log(
      `[sync] push user=${user.id} added=${addedCount} modified=${modifiedCount} removed=${removedCount} conflicts=${conflicts.length}`
    );
  }

  return c.json({
    ok: true,
    data: {
      added_count: addedCount,
      modified_count: modifiedCount,
      removed_count: removedCount,
      deduped: deduped.length > 0 ? deduped : undefined,
      conflicts,
      server_time: serverTime,
    },
  });
});

// ─── 8.5 POST /api/sync/force ─────────────────────────────────────────
app.post('/force', async (c) => {
  const start = Date.now();
  const user = c.get('user' as never) as User;
  const token = c.get('token' as never) as ApiToken | undefined;

  const body = await c.req.json().catch(() => ({}));
  const parsed = forceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' },
      400
    );
  }
  const { bookmarks } = parsed.data;

  let total = 0;
  const tx = db.transaction(() => {
    const ts = now();
    // Soft-delete every active row for this user
    softDeleteAllActive.run(ts, ts, user.id);
    // Fresh INSERT with client-supplied ids
    for (const b of bookmarks) {
      insertBookmark.run(
        b.id,
        user.id,
        b.type,
        b.parent_id ?? null,
        b.root,
        b.name,
        b.url ?? null,
        b.position ?? 0,
        b.date_added ?? ts,
        b.date_modified ?? ts,
        ts,
        ts
      );
      total++;
    }
  });

  try {
    tx();
  } catch (err) {
    logger.error('force transaction failed', err);
    return c.json(
      { ok: false, error: 'Transaction failed', code: 'SERVER_ERROR' },
      500
    );
  }

  const serverTime = now();
  const { ip, ua } = getClientMeta(c);
  try {
    insertSyncLog.run(
      user.id,
      token?.id ?? null,
      'force_push',
      total,
      0,
      0,
      ua,
      ip,
      Date.now() - start,
      serverTime
    );
  } catch (err) {
    logger.warn('sync_logs insert failed (force)', err);
  }

  return c.json({
    ok: true,
    data: { total, server_time: serverTime },
  });
});

export default app;
