import { Hono } from 'hono';
import { z } from 'zod';
import { db, now, type User } from '../db.js';
import { hashPassword, verifyPassword, signJwt } from '../lib/auth.js';
import { config } from '../config.js';
import { requireJwt, type AuthContext } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';

const app = new Hono();

const registerSchema = z.object({
  username: z.string().min(3).max(64),
  email: z.string().email().optional(),
  password: z.string().min(6).max(128),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const passwordChangeSchema = z.object({
  old_password: z.string().min(1),
  new_password: z.string().min(6).max(128),
});

const getUserByUsername = db.prepare<[string], User>('SELECT * FROM users WHERE username = ?');
const getUserById = db.prepare<[number], User>('SELECT * FROM users WHERE id = ?');
const countUsers = db.prepare<[], { c: number }>('SELECT COUNT(*) as c FROM users');
const insertUser = db.prepare(
  'INSERT INTO users (username, email, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const updatePasswordStmt = db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?');

app.post('/register', rateLimit('register', 5, 60_000), async (c) => {
  const parsed = registerSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { username, email, password } = parsed.data;

  const userCount = countUsers.get()?.c || 0;
  const isFirstUser = userCount === 0;

  if (!isFirstUser && !config.registrationOpen) {
    return c.json({ ok: false, error: 'Registration closed', code: 'REG_CLOSED' }, 403);
  }

  if (getUserByUsername.get(username)) {
    return c.json({ ok: false, error: 'Username already exists', code: 'CONFLICT' }, 409);
  }

  const passwordHash = await hashPassword(password);
  const ts = now();
  const info = insertUser.run(username, email || null, passwordHash, isFirstUser ? 1 : 0, ts, ts);
  const userId = Number(info.lastInsertRowid);

  const token = await signJwt(userId);
  const user = getUserById.get(userId)!;
  return c.json({
    ok: true,
    data: {
      user: publicUser(user),
      token,
    },
  });
});

app.post('/login', rateLimit('login', 5, 60_000), async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { username, password } = parsed.data;
  const user = getUserByUsername.get(username);
  if (!user) {
    return c.json({ ok: false, error: 'Invalid credentials', code: 'UNAUTHORIZED' }, 401);
  }
  const ok = await verifyPassword(user.password_hash, password);
  if (!ok) {
    return c.json({ ok: false, error: 'Invalid credentials', code: 'UNAUTHORIZED' }, 401);
  }
  const token = await signJwt(user.id);
  return c.json({
    ok: true,
    data: { user: publicUser(user), token },
  });
});

app.get('/status', (c) => {
  const userCount = countUsers.get()?.c || 0;
  return c.json({
    ok: true,
    data: {
      has_users: userCount > 0,
      registration_open: config.registrationOpen,
      can_register: userCount === 0 || config.registrationOpen,
    },
  });
});

app.post('/logout', (c) => {
  return c.json({ ok: true, data: { logged_out: true } });
});

app.get('/me', requireJwt, (c) => {
  const user = c.get('user' as never) as User;
  return c.json({ ok: true, data: publicUser(user) });
});

app.put('/password', requireJwt, async (c) => {
  const user = c.get('user' as never) as User;
  const parsed = passwordChangeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { old_password, new_password } = parsed.data;
  const ok = await verifyPassword(user.password_hash, old_password);
  if (!ok) return c.json({ ok: false, error: 'Old password incorrect', code: 'UNAUTHORIZED' }, 401);
  const newHash = await hashPassword(new_password);
  updatePasswordStmt.run(newHash, now(), user.id);
  return c.json({ ok: true, data: { changed: true } });
});

function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    is_admin: !!u.is_admin,
    created_at: u.created_at,
  };
}

export default app;
