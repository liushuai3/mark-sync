// v3.0 refactor: `path` column dropped, `updated_at` renamed to
// `server_updated_at`. Route now uses parent_id + server-derived timestamps
// (SRS §5.2).
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
    clauses.push('(name LIKE ? OR url LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like);
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

  // Attach computed `path` (folder chain from root) for each item.
  // v3.0 dropped the `path` column; the UI still wants a human-readable
  // location, so we derive it on read.
  const rootLabels: Record<string, string> = {
    bookmark_bar: '书签栏',
    other: '其他书签',
    mobile: '移动书签',
  };
  const parentIds = Array.from(
    new Set(items.map((it) => it.parent_id).filter((v): v is string => !!v))
  );
  const ancestors = new Map<string, { name: string; parent_id: string | null; root: string }>();
  if (parentIds.length > 0) {
    // Walk ancestors in batches; typical bookmark tree is shallow (<10)
    let queue = parentIds.slice();
    while (queue.length > 0) {
      const missing = queue.filter((id) => !ancestors.has(id));
      if (missing.length === 0) break;
      const placeholders = missing.map(() => '?').join(',');
      const rows = db
        .prepare<any[], { id: string; name: string; parent_id: string | null; root: string }>(
          `SELECT id, name, parent_id, root FROM bookmarks WHERE user_id = ? AND id IN (${placeholders})`
        )
        .all(user.id, ...missing);
      for (const r of rows) {
        ancestors.set(r.id, { name: r.name, parent_id: r.parent_id, root: r.root });
      }
      queue = rows.map((r) => r.parent_id).filter((v): v is string => !!v);
    }
  }
  const pathFor = (item: Bookmark): string => {
    const parts: string[] = [];
    let cur = item.parent_id;
    let guard = 0;
    while (cur && guard++ < 64) {
      const anc = ancestors.get(cur);
      if (!anc) break;
      parts.unshift(anc.name);
      cur = anc.parent_id;
    }
    const rootName = rootLabels[item.root] || item.root;
    return parts.length > 0 ? `${rootName} / ${parts.join(' / ')}` : rootName;
  };
  const itemsWithPath = items.map((it) => ({ ...it, path: pathFor(it) }));

  return c.json({
    ok: true,
    data: { total, page, page_size, items: itemsWithPath },
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
        version = version + 1,
        server_updated_at = ?,
        date_modified = ?
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .run(
      patch.name ?? null,
      patch.url ?? null,
      patch.parent_id ?? null,
      ts,
      ts,
      id,
      user.id
    );
  if (info.changes === 0) {
    return c.json({ ok: false, error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
  return c.json({ ok: true, data: { updated: true } });
});

// ─── P1-A: cascading tombstones ───────────────────────────────────────
// Deleting only a folder row leaves its descendants active with a dead
// parent_id. Clients then fail to apply the folder tombstone ("cannot
// remove non-empty folder"), wedge the pull checkpoint for 6 cycles, and a
// forced re-merge re-homes every orphan to the bookmark-bar root — i.e.
// the web delete resurrects the whole subtree in the wrong place. Every
// web delete therefore tombstones the entire subtree, level by level.
const selectActiveChildren = db.prepare<[number, string], { id: string }>(
  'SELECT id FROM bookmarks WHERE user_id = ? AND parent_id = ? AND deleted_at IS NULL'
);
const tombstoneById = db.prepare(
  'UPDATE bookmarks SET deleted_at = ?, server_updated_at = ?, date_modified = ?, version = version + 1 WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
);

/**
 * Tombstone `rootId` and all of its active descendants (breadth-first).
 * Returns the number of rows tombstoned. Idempotent; safe to call inside
 * an outer transaction.
 */
export function tombstoneSubtree(userId: number, rootId: string, ts: number): number {
  let count = 0;
  const queue: string[] = [rootId];
  const seen = new Set<string>([rootId]); // cycle guard (parent_id loops)
  while (queue.length > 0) {
    const id = queue.shift()!;
    const info = tombstoneById.run(ts, ts, ts, id, userId);
    if (info.changes > 0) count++;
    for (const child of selectActiveChildren.all(userId, id)) {
      if (!seen.has(child.id)) {
        seen.add(child.id);
        queue.push(child.id);
      }
    }
  }
  return count;
}

app.delete('/:id', (c) => {
  const user = c.get('user' as never) as User;
  const id = c.req.param('id');
  const ts = now();
  // P1-A: cascade — tombstone the whole subtree, not just the row itself.
  const count = db.transaction(() => tombstoneSubtree(user.id, id, ts))();
  if (count === 0) {
    return c.json({ ok: false, error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
  return c.json({ ok: true, data: { deleted: true, cascaded: count } });
});

app.post('/batch-delete', async (c) => {
  const user = c.get('user' as never) as User;
  const parsed = batchDeleteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { ids } = parsed.data;
  const ts = now();
  let count = 0;
  // P1-A: each id cascades to its subtree inside one transaction.
  const tx = db.transaction(() => {
    for (const id of ids) {
      count += tombstoneSubtree(user.id, id, ts);
    }
  });
  tx();
  return c.json({ ok: true, data: { deleted: count } });
});

export default app;
