import { Hono } from 'hono';
import { z } from 'zod';
import { db, now, type Bookmark, type User, type ApiToken } from '../db.js';
import { requireApiToken } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';

const app = new Hono();
app.use('*', requireApiToken);

const bookmarkInput = z.object({
  id: z.string().min(1),
  type: z.enum(['folder', 'url']),
  parent_id: z.string().nullable().optional(),
  root: z.enum(['bookmark_bar', 'other', 'mobile']),
  name: z.string(),
  url: z.string().nullable().optional(),
  path: z.string(),
  position: z.number().int().optional(),
  date_added: z.number().nullable().optional(),
  date_modified: z.number().nullable().optional(),
});

const pushSchema = z.object({
  added: z.array(bookmarkInput).default([]),
  modified: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        url: z.string().nullable().optional(),
        parent_id: z.string().nullable().optional(),
        path: z.string().optional(),
        position: z.number().int().optional(),
        date_modified: z.number().nullable().optional(),
      })
    )
    .default([]),
  removed: z.array(z.string()).default([]),
});

const forceSchema = z.object({
  bookmarks: z.array(bookmarkInput),
});

// Prepared statements
const selectAllActive = db.prepare<[number], Bookmark>(
  'SELECT * FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL ORDER BY root, position, name'
);
const selectSince = db.prepare<[number, number], Bookmark>(
  'SELECT * FROM bookmarks WHERE user_id = ? AND updated_at > ? ORDER BY updated_at'
);
const findFolderByPath = db.prepare<[number, string], Bookmark>(
  "SELECT * FROM bookmarks WHERE user_id = ? AND path = ? AND type = 'folder' AND deleted_at IS NULL LIMIT 1"
);
const findUrlByUrlPath = db.prepare<[number, string, string], Bookmark>(
  "SELECT * FROM bookmarks WHERE user_id = ? AND url = ? AND path = ? AND type = 'url' AND deleted_at IS NULL LIMIT 1"
);
const findById = db.prepare<[string, number], Bookmark>(
  'SELECT * FROM bookmarks WHERE id = ? AND user_id = ?'
);
const insertBookmark = db.prepare(
  `INSERT INTO bookmarks (id, user_id, type, parent_id, root, name, url, path, position, date_added, date_modified, deleted_at, version, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`
);
const updateBookmarkStmt = db.prepare(
  `UPDATE bookmarks SET name = COALESCE(?, name), url = COALESCE(?, url), parent_id = COALESCE(?, parent_id), path = COALESCE(?, path), position = COALESCE(?, position), date_modified = COALESCE(?, date_modified), version = version + 1, updated_at = ?
   WHERE id = ? AND user_id = ?`
);
const softDelete = db.prepare(
  'UPDATE bookmarks SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
);
const softDeleteAll = db.prepare(
  'UPDATE bookmarks SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE user_id = ? AND deleted_at IS NULL'
);
const insertSyncLog = db.prepare(
  `INSERT INTO sync_logs (user_id, token_id, action, added_count, removed_count, modified_count, device_info, ip, duration_ms, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

function getClientMeta(c: any) {
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    c.req.header('x-real-ip') ||
    null;
  const ua = c.req.header('user-agent') || null;
  return { ip, ua };
}

app.get('/pull', (c) => {
  const start = Date.now();
  const user = c.get('user' as never) as User;
  const token = c.get('token' as never) as ApiToken | undefined;
  const sinceStr = c.req.query('since');
  const since = sinceStr ? Number(sinceStr) : null;

  const rows = since != null && !isNaN(since)
    ? selectSince.all(user.id, since)
    : selectAllActive.all(user.id);

  const { ip, ua } = getClientMeta(c);
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

  return c.json({
    ok: true,
    data: {
      bookmarks: rows,
      server_time: now(),
    },
  });
});

app.post('/push', async (c) => {
  const start = Date.now();
  const user = c.get('user' as never) as User;
  const token = c.get('token' as never) as ApiToken | undefined;
  const body = await c.req.json().catch(() => ({}));
  const parsed = pushSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { added, modified, removed } = parsed.data;

  let addedCount = 0;
  let modifiedCount = 0;
  let removedCount = 0;
  let skippedCount = 0;

  const tx = db.transaction(() => {
    const ts = now();

    // Added: dedupe by (path) for folders, (url, path) for urls
    for (const b of added) {
      let existing: Bookmark | undefined;
      if (b.type === 'folder') {
        existing = findFolderByPath.get(user.id, b.path);
      } else {
        existing = findUrlByUrlPath.get(user.id, b.url || '', b.path);
      }
      if (existing) {
        skippedCount++;
        continue;
      }
      // Also skip if same id already exists (even soft-deleted)
      const byId = findById.get(b.id, user.id);
      if (byId) {
        skippedCount++;
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
        b.path,
        b.position ?? 0,
        b.date_added ?? ts,
        b.date_modified ?? null,
        ts,
        ts
      );
      addedCount++;
    }

    // Modified
    for (const m of modified) {
      const info = updateBookmarkStmt.run(
        m.name ?? null,
        m.url ?? null,
        m.parent_id ?? null,
        m.path ?? null,
        m.position ?? null,
        m.date_modified ?? ts,
        ts,
        m.id,
        user.id
      );
      if (info.changes > 0) modifiedCount++;
    }

    // Removed (soft delete)
    for (const id of removed) {
      const info = softDelete.run(ts, ts, id, user.id);
      if (info.changes > 0) removedCount++;
    }
  });

  try {
    tx();
  } catch (err) {
    logger.error('push transaction failed', err);
    return c.json({ ok: false, error: 'Transaction failed', code: 'SERVER_ERROR' }, 500);
  }

  const { ip, ua } = getClientMeta(c);
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
    now()
  );

  return c.json({
    ok: true,
    data: {
      added_count: addedCount,
      modified_count: modifiedCount,
      removed_count: removedCount,
      skipped_count: skippedCount,
    },
  });
});

app.post('/force', async (c) => {
  const start = Date.now();
  const user = c.get('user' as never) as User;
  const token = c.get('token' as never) as ApiToken | undefined;
  const body = await c.req.json().catch(() => ({}));
  const parsed = forceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { bookmarks } = parsed.data;

  let insertedCount = 0;
  const tx = db.transaction(() => {
    const ts = now();
    // Soft delete all existing
    softDeleteAll.run(ts, ts, user.id);
    // Insert new
    for (const b of bookmarks) {
      insertBookmark.run(
        b.id,
        user.id,
        b.type,
        b.parent_id ?? null,
        b.root,
        b.name,
        b.url ?? null,
        b.path,
        b.position ?? 0,
        b.date_added ?? ts,
        b.date_modified ?? null,
        ts,
        ts
      );
      insertedCount++;
    }
  });

  try {
    tx();
  } catch (err) {
    logger.error('force transaction failed', err);
    return c.json({ ok: false, error: 'Transaction failed', code: 'SERVER_ERROR' }, 500);
  }

  const { ip, ua } = getClientMeta(c);
  insertSyncLog.run(
    user.id,
    token?.id ?? null,
    'force_push',
    insertedCount,
    0,
    0,
    ua,
    ip,
    Date.now() - start,
    now()
  );

  return c.json({ ok: true, data: { total: insertedCount } });
});

export default app;
