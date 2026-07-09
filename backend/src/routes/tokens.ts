import { Hono } from 'hono';
import { z } from 'zod';
import { db, now, type ApiToken, type User } from '../db.js';
import { generateApiToken } from '../lib/crypto.js';
import { requireJwt } from '../middleware/auth.js';

const app = new Hono();
app.use('*', requireJwt);

const listTokens = db.prepare<[number], ApiToken>(
  'SELECT * FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC'
);
const insertToken = db.prepare(
  'INSERT INTO api_tokens (user_id, name, token_hash, token_prefix, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const revokeToken = db.prepare(
  'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL'
);

const createSchema = z.object({
  name: z.string().min(1).max(128),
  expires_in_days: z.number().int().positive().max(3650).nullable().optional(),
});

app.get('/', (c) => {
  const user = c.get('user' as never) as User;
  const rows = listTokens.all(user.id);
  const data = rows.map((r) => ({
    id: r.id,
    name: r.name,
    token_prefix: r.token_prefix,
    last_used_at: r.last_used_at,
    expires_at: r.expires_at,
    created_at: r.created_at,
  }));
  return c.json({ ok: true, data });
});

app.post('/', async (c) => {
  const user = c.get('user' as never) as User;
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { name, expires_in_days } = parsed.data;
  const { token, hash, prefix } = generateApiToken();
  const ts = now();
  const expiresAt = expires_in_days ? ts + expires_in_days * 86400_000 : null;
  const info = insertToken.run(user.id, name, hash, prefix, expiresAt, ts);
  return c.json({
    ok: true,
    data: {
      id: Number(info.lastInsertRowid),
      name,
      token, // 一次性明文，仅此一次
      token_prefix: prefix,
      expires_at: expiresAt,
      created_at: ts,
    },
  });
});

app.delete('/:id', (c) => {
  const user = c.get('user' as never) as User;
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: 'Invalid id', code: 'INVALID_INPUT' }, 400);
  const info = revokeToken.run(now(), id, user.id);
  if (info.changes === 0) {
    return c.json({ ok: false, error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
  return c.json({ ok: true, data: { revoked: true } });
});

export default app;
