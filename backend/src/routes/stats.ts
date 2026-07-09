import { Hono } from 'hono';
import { z } from 'zod';
import { db, type SyncLog, type User } from '../db.js';
import { requireJwt } from '../middleware/auth.js';

const app = new Hono();
app.use('*', requireJwt);

app.get('/stats', (c) => {
  const user = c.get('user' as never) as User;

  const bookmarksRow = db
    .prepare<[number], { total: number; folders: number; urls: number }>(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN type='folder' THEN 1 ELSE 0 END) AS folders,
        SUM(CASE WHEN type='url' THEN 1 ELSE 0 END) AS urls
      FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL`
    )
    .get(user.id);

  const tokensRow = db
    .prepare<[number], { c: number }>(
      'SELECT COUNT(*) as c FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL'
    )
    .get(user.id);

  const lastSyncRow = db
    .prepare<[number], { last: number | null }>(
      'SELECT MAX(created_at) as last FROM sync_logs WHERE user_id = ?'
    )
    .get(user.id);

  const recentSyncs = db
    .prepare<[number], SyncLog>(
      'SELECT * FROM sync_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
    )
    .all(user.id);

  return c.json({
    ok: true,
    data: {
      total_bookmarks: bookmarksRow?.urls || 0,
      total_folders: bookmarksRow?.folders || 0,
      total_all: bookmarksRow?.total || 0,
      total_tokens: tokensRow?.c || 0,
      last_sync_at: lastSyncRow?.last || null,
      recent_syncs: recentSyncs,
    },
  });
});

const logSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(200).default(20),
});

app.get('/sync-logs', (c) => {
  const user = c.get('user' as never) as User;
  const q = logSchema.safeParse(c.req.query());
  if (!q.success) {
    return c.json({ ok: false, error: q.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { page, page_size } = q.data;
  const totalRow = db
    .prepare<[number], { c: number }>('SELECT COUNT(*) as c FROM sync_logs WHERE user_id = ?')
    .get(user.id);
  const total = totalRow?.c || 0;
  const offset = (page - 1) * page_size;
  const items = db
    .prepare<[number, number, number], SyncLog>(
      'SELECT * FROM sync_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    )
    .all(user.id, page_size, offset);
  return c.json({ ok: true, data: { total, page, page_size, items } });
});

export default app;
