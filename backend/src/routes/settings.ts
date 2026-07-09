import { Hono } from 'hono';
import { z } from 'zod';
import { db, now, type User } from '../db.js';
import { requireJwt } from '../middleware/auth.js';
import { config } from '../config.js';

const app = new Hono();
app.use('*', requireJwt);

const getConfig = db.prepare<[string], { value: string; updated_at: number }>(
  'SELECT value, updated_at FROM settings WHERE key = ? LIMIT 1'
);
const upsertConfig = db.prepare<[string, string, number]>(
  'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
);

// 注册开关
app.get('/registration', (c) => {
  const row = getConfig.get('registration_open');
  const enabled = row ? row.value === 'true' : config.registrationOpen;
  return c.json({ ok: true, data: { enabled, source: row ? 'database' : 'env' } });
});

app.put('/registration', async (c) => {
  const user = c.get('user' as never) as User;
  if (!user.is_admin) {
    return c.json({ ok: false, error: '只有管理员可以修改此设置', code: 'FORBIDDEN' }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ enabled: z.boolean() }).safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'Invalid input', code: 'INVALID_INPUT' }, 400);
  }
  const ts = now();
  upsertConfig.run('registration_open', parsed.data.enabled ? 'true' : 'false', ts);
  return c.json({ ok: true, data: { enabled: parsed.data.enabled } });
});

// 获取所有设置
app.get('/', (c) => {
  const rows = db.prepare('SELECT * FROM settings').all() as Array<{ key: string; value: string }>;
  const data: Record<string, string> = {};
  for (const row of rows) {
    data[row.key] = row.value;
  }
  return c.json({ ok: true, data });
});

// 批量更新设置（仅管理员）
app.put('/', async (c) => {
  const user = c.get('user' as never) as User;
  if (!user.is_admin) {
    return c.json({ ok: false, error: '只有管理员可以修改此设置', code: 'FORBIDDEN' }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const ts = now();
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') {
      upsertConfig.run(key, value, ts);
    }
  }
  return c.json({ ok: true, data: body });
});

export default app;
