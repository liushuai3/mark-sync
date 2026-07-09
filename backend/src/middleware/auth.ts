import type { Context, Next } from 'hono';
import { db, type User, type ApiToken } from '../db.js';
import { verifyJwt } from '../lib/auth.js';
import { sha256Hex } from '../lib/crypto.js';

export type AuthContext = {
  user: User;
  authType: 'jwt' | 'token';
  token?: ApiToken;
};

const getUserById = db.prepare<[number], User>('SELECT * FROM users WHERE id = ?');
const getTokenByHash = db.prepare<[string], ApiToken>(
  "SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > strftime('%s','now')*1000)"
);
const updateTokenUsed = db.prepare<[number, number]>(
  'UPDATE api_tokens SET last_used_at = ? WHERE id = ?'
);

function extractToken(c: Context): string | null {
  const h = c.req.header('Authorization') || c.req.header('authorization');
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function unauthorized(c: Context, msg = 'Unauthorized') {
  return c.json({ ok: false, error: msg, code: 'UNAUTHORIZED' }, 401);
}

// Auth requiring JWT only
export async function requireJwt(c: Context, next: Next) {
  const token = extractToken(c);
  if (!token) return unauthorized(c);
  if (token.startsWith('mks_')) {
    return unauthorized(c, 'JWT required, API token not accepted here');
  }
  const payload = await verifyJwt(token);
  if (!payload) return unauthorized(c, 'Invalid or expired token');
  const user = getUserById.get(payload.userId);
  if (!user) return unauthorized(c, 'User not found');
  c.set('user', user);
  c.set('authType', 'jwt');
  await next();
}

// Auth accepting either JWT or API token (useful for endpoints like /auth/me
// that both the web UI and the extension need to hit for identity checks).
export async function requireAuth(c: Context, next: Next) {
  const token = extractToken(c);
  if (!token) return unauthorized(c);
  if (token.startsWith('mks_')) {
    const hash = sha256Hex(token);
    const row = getTokenByHash.get(hash);
    if (!row) return unauthorized(c, 'Invalid or expired token');
    const user = getUserById.get(row.user_id);
    if (!user) return unauthorized(c, 'User not found');
    updateTokenUsed.run(Date.now(), row.id);
    c.set('user', user);
    c.set('authType', 'token');
    c.set('token', row);
  } else {
    const payload = await verifyJwt(token);
    if (!payload) return unauthorized(c, 'Invalid or expired token');
    const user = getUserById.get(payload.userId);
    if (!user) return unauthorized(c, 'User not found');
    c.set('user', user);
    c.set('authType', 'jwt');
  }
  await next();
}

// Auth requiring API token only
export async function requireApiToken(c: Context, next: Next) {
  const token = extractToken(c);
  if (!token) return unauthorized(c);
  if (!token.startsWith('mks_')) {
    return unauthorized(c, 'API token required');
  }
  const hash = sha256Hex(token);
  const row = getTokenByHash.get(hash);
  if (!row) return unauthorized(c, 'Invalid or expired token');
  const user = getUserById.get(row.user_id);
  if (!user) return unauthorized(c, 'User not found');
  updateTokenUsed.run(Date.now(), row.id);
  c.set('user', user);
  c.set('authType', 'token');
  c.set('token', row);
  await next();
}
