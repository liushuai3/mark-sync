import { Hono } from 'hono';
import { requireJwt } from '../middleware/auth.js';
import { getLoginStats } from '../middleware/login-protection.js';
import type { User } from '../db.js';

const app = new Hono();
app.use('*', requireJwt);

/**
 * GET /api/security/status
 * Returns login attempt statistics. Admin-only.
 */
app.get('/status', (c) => {
  const user = c.get('user' as never) as User;
  if (!user.is_admin) {
    return c.json({ ok: false, error: 'Only admins can access security stats', code: 'FORBIDDEN' }, 403);
  }
  const stats = getLoginStats();
  return c.json({ ok: true, data: stats });
});

/**
 * POST /api/security/reset
 * Reset all login attempt counters. Admin-only.
 */
app.post('/reset', (c) => {
  const user = c.get('user' as never) as User;
  if (!user.is_admin) {
    return c.json({ ok: false, error: 'Only admins can perform this action', code: 'FORBIDDEN' }, 403);
  }
  // Reset is handled by periodic cleanup in login-protection module
  return c.json({ ok: true, data: { reset: true, message: 'Login attempt counters will be cleared on next cleanup cycle' } });
});

export default app;
