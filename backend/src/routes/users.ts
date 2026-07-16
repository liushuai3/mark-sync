import { Hono } from 'hono';
import { z } from 'zod';
import { db, now, type User } from '../db.js';
import { requireJwt } from '../middleware/auth.js';
import { hashPassword } from '../lib/auth.js';

const app = new Hono();
app.use('*', requireJwt);

const listUsers = db.prepare<[], User>('SELECT * FROM users ORDER BY created_at ASC');
const getUserById = db.prepare<[number], User>('SELECT * FROM users WHERE id = ?');
const deleteUser = db.prepare('DELETE FROM users WHERE id = ? AND is_admin = 0');
const setAdmin = db.prepare('UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?');
const updateEmail = db.prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?');
const updatePasswordHash = db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?');

function requireAdmin(c: any, next: any) {
  const user = c.get('user' as never) as User;
  if (!user.is_admin) {
    return c.json({ ok: false, error: '只有管理员可以执行此操作', code: 'FORBIDDEN' }, 403);
  }
  return next();
}

app.get('/', (c) => {
  const user = c.get('user' as never) as User;
  if (!user.is_admin) {
    return c.json({ ok: false, error: '只有管理员可以查看用户列表', code: 'FORBIDDEN' }, 403);
  }
  const rows = listUsers.all();
  const data = rows.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
    is_admin: !!u.is_admin,
    created_at: u.created_at,
    updated_at: u.updated_at,
  }));
  return c.json({ ok: true, data });
});

app.delete('/:id', async (c) => {
  const currentUser = c.get('user' as never) as User;
  if (!currentUser.is_admin) {
    return c.json({ ok: false, error: '只有管理员可以删除用户', code: 'FORBIDDEN' }, 403);
  }
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: 'Invalid id', code: 'INVALID_INPUT' }, 400);
  if (id === currentUser.id) {
    return c.json({ ok: false, error: '不能删除自己', code: 'FORBIDDEN' }, 400);
  }
  const target = getUserById.get(id);
  if (!target) return c.json({ ok: false, error: 'Not found', code: 'NOT_FOUND' }, 404);
  if (target.is_admin) {
    return c.json({ ok: false, error: '不能删除其他管理员', code: 'FORBIDDEN' }, 400);
  }
  const info = deleteUser.run(id);
  if (info.changes === 0) return c.json({ ok: false, error: '删除失败', code: 'SERVER_ERROR' }, 500);
  return c.json({ ok: true, data: { deleted: true } });
});

app.put('/:id', async (c) => {
  const currentUser = c.get('user' as never) as User;
  if (!currentUser.is_admin) {
    return c.json({ ok: false, error: '只有管理员可以修改用户', code: 'FORBIDDEN' }, 403);
  }
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: 'Invalid id', code: 'INVALID_INPUT' }, 400);
  const target = getUserById.get(id);
  if (!target) return c.json({ ok: false, error: 'Not found', code: 'NOT_FOUND' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    is_admin: z.boolean().optional(),
    email: z.string().optional(),
    password: z.string().min(6).max(128).optional(),
  }).safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }

  const ts = now();
  if (parsed.data.is_admin !== undefined) {
    setAdmin.run(parsed.data.is_admin ? 1 : 0, ts, id);
  }
  if (parsed.data.email !== undefined) {
    updateEmail.run(parsed.data.email || null, ts, id);
  }
  if (parsed.data.password) {
    const hash = await hashPassword(parsed.data.password);
    updatePasswordHash.run(hash, ts, id);
  }

  const updated = getUserById.get(id)!;
  return c.json({
    ok: true,
    data: {
      id: updated.id,
      username: updated.username,
      email: updated.email,
      is_admin: !!updated.is_admin,
      updated_at: updated.updated_at,
    },
  });
});

export default app;
