// TODO(P1): v3.0 refactor — remove legacy `path` field usage and align
// this route with `server_updated_at` versioning (SRS §5.2). The UPDATE
// statement below still references dropped columns and will fail at
// runtime until P1 rewrites it.
import { Hono } from 'hono';
import { z } from 'zod';
import { db, now, type Bookmark, type User } from '../db.js';
import { requireJwt } from '../middleware/auth.js';

const app = new Hono();
app.use('*', requireJwt);

const listSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(200).default(50),
  search: z.string().optional(),
  root: z.enum(['bookmark_bar', 'other', 'mobile']).optional(),
  parent_id: z.string().optional(),
  type: z.enum(['folder', 'url']).optional(),
});

const editSchema = z.object({
  name: z.string().min(1).optional(),
  url: z.string().nullable().optional(),
  parent_id: z.string().nullable().optional(),
  path: z.string().optional(),
});

const batchDeleteSchema = z.object({
  ids: z.array(z.string()).min(1).max(500),
});

app.get('/', (c) => {
  const user = c.get('user' as never) as User;
  const q = listSchema.safeParse(c.req.query());
  if (!q.success) {
    return c.json({ ok: false, error: q.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { page, page_size, search, root, parent_id, type } = q.data;

  const clauses = ['user_id = ?', 'deleted_at IS NULL'];
  const params: any[] = [user.id];

  if (search) {
    clauses.push('(name LIKE ? OR url LIKE ? OR path LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if (root) {
    clauses.push('root = ?');
    params.push(root);
  }
  if (parent_id !== undefined) {
    if (parent_id === '' || parent_id === 'null') {
      clauses.push('parent_id IS NULL');
    } else {
      clauses.push('parent_id = ?');
      params.push(parent_id);
    }
  }
  if (type) {
    clauses.push('type = ?');
    params.push(type);
  }

  const where = clauses.join(' AND ');
  const totalRow = db.prepare<any[], { c: number }>(
    `SELECT COUNT(*) as c FROM bookmarks WHERE ${where}`
  ).get(...params);
  const total = totalRow?.c || 0;

  const offset = (page - 1) * page_size;
  const items = db
    .prepare<any[], Bookmark>(
      `SELECT * FROM bookmarks WHERE ${where} ORDER BY type DESC, position, name LIMIT ? OFFSET ?`
    )
    .all(...params, page_size, offset);

  return c.json({
    ok: true,
    data: { total, page, page_size, items },
  });
});

app.get('/tree', (c) => {
  const user = c.get('user' as never) as User;
  const rows = db
    .prepare<[number], Bookmark>(
      'SELECT * FROM bookmarks WHERE user_id = ? AND deleted_at IS NULL ORDER BY position, name'
    )
    .all(user.id);

  const roots: any = {
    bookmark_bar: { id: 'root_bookmark_bar', name: '书签栏', root: 'bookmark_bar', type: 'folder', children: [] },
    other: { id: 'root_other', name: '其他书签', root: 'other', type: 'folder', children: [] },
    mobile: { id: 'root_mobile', name: '移动书签', root: 'mobile', type: 'folder', children: [] },
  };

  const nodes: Record<string, any> = {};
  for (const r of rows) {
    nodes[r.id] = { ...r, children: [] };
  }
  for (const r of rows) {
    const node = nodes[r.id];
    if (r.parent_id && nodes[r.parent_id]) {
      nodes[r.parent_id].children.push(node);
    } else {
      const rootNode = roots[r.root];
      if (rootNode) rootNode.children.push(node);
    }
  }

  return c.json({ ok: true, data: roots });
});

app.put('/:id', async (c) => {
  const user = c.get('user' as never) as User;
  const id = c.req.param('id');
  const parsed = editSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const patch = parsed.data;
  const ts = now();
  const info = db
    .prepare(
      `UPDATE bookmarks SET
        name = COALESCE(?, name),
        url = COALESCE(?, url),
        parent_id = COALESCE(?, parent_id),
        path = COALESCE(?, path),
        version = version + 1,
        updated_at = ?
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .run(
      patch.name ?? null,
      patch.url ?? null,
      patch.parent_id ?? null,
      patch.path ?? null,
      ts,
      id,
      user.id
    );
  if (info.changes === 0) {
    return c.json({ ok: false, error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
  return c.json({ ok: true, data: { updated: true } });
});

app.delete('/:id', (c) => {
  const user = c.get('user' as never) as User;
  const id = c.req.param('id');
  const ts = now();
  const info = db
    .prepare(
      'UPDATE bookmarks SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    )
    .run(ts, ts, id, user.id);
  if (info.changes === 0) {
    return c.json({ ok: false, error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
  return c.json({ ok: true, data: { deleted: true } });
});

app.post('/batch-delete', async (c) => {
  const user = c.get('user' as never) as User;
  const parsed = batchDeleteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { ids } = parsed.data;
  const ts = now();
  const stmt = db.prepare(
    'UPDATE bookmarks SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  );
  let count = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const info = stmt.run(ts, ts, id, user.id);
      if (info.changes > 0) count++;
    }
  });
  tx();
  return c.json({ ok: true, data: { deleted: count } });
});

export default app;
