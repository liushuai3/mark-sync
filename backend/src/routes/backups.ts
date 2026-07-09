import { Hono } from 'hono';
import { z } from 'zod';
import { requireJwt } from '../middleware/auth.js';
import type { User } from '../db.js';
import {
  createBackup,
  listBackups,
  deleteBackup,
  restoreBackup,
  getBackupConfig,
  updateBackupConfig,
  readBackupFile,
  pruneOldBackups,
} from '../lib/backup.js';

const app = new Hono();
app.use('*', requireJwt);

const createSchema = z.object({
  name: z.string().min(1).max(128).optional(),
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  interval_hours: z.number().int().min(1).max(24 * 30).optional(),
  hour_of_day: z.number().int().min(0).max(23).optional(),
  keep_count: z.number().int().min(1).max(100).optional(),
});

app.get('/config', (c) => {
  const user = c.get('user' as never) as User;
  return c.json({ ok: true, data: getBackupConfig(user.id) });
});

app.put('/config', async (c) => {
  const user = c.get('user' as never) as User;
  const body = await c.req.json().catch(() => ({}));
  const parsed = configSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const cfg = updateBackupConfig(user.id, parsed.data);
  return c.json({ ok: true, data: cfg });
});

app.get('/', (c) => {
  const user = c.get('user' as never) as User;
  const rows = listBackups(user.id);
  return c.json({ ok: true, data: rows });
});

app.post('/', async (c) => {
  const user = c.get('user' as never) as User;
  const body = await c.req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const row = createBackup({ userId: user.id, name: parsed.data.name, kind: 'manual' });
  try {
    const cfg = getBackupConfig(user.id);
    pruneOldBackups(user.id, cfg.keep_count);
  } catch {}
  return c.json({ ok: true, data: row });
});

app.delete('/:id', (c) => {
  const user = c.get('user' as never) as User;
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: 'Invalid id', code: 'INVALID_INPUT' }, 400);
  const removed = deleteBackup(user.id, id);
  if (!removed) return c.json({ ok: false, error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({ ok: true, data: { deleted: true } });
});

app.post('/:id/restore', (c) => {
  const user = c.get('user' as never) as User;
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: 'Invalid id', code: 'INVALID_INPUT' }, 400);
  try {
    const result = restoreBackup(user.id, id);
    return c.json({ ok: true, data: result });
  } catch (err: any) {
    return c.json({ ok: false, error: err?.message || 'Restore failed', code: 'RESTORE_FAILED' }, 400);
  }
});

app.get('/:id/download', (c) => {
  const user = c.get('user' as never) as User;
  const id = Number(c.req.param('id'));
  if (!id) return c.json({ ok: false, error: 'Invalid id', code: 'INVALID_INPUT' }, 400);
  const file = readBackupFile(user.id, id);
  if (!file) return c.json({ ok: false, error: 'Not found', code: 'NOT_FOUND' }, 404);
  return new Response(new Uint8Array(file.buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${file.name}"`,
      'Cache-Control': 'no-store',
    },
  });
});

export default app;
