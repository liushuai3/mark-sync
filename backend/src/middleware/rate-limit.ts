import type { Context, Next } from 'hono';

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function getClientKey(c: Context, scope: string): string {
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    c.req.header('x-real-ip') ||
    'unknown';
  return `${scope}:${ip}`;
}

export function rateLimit(scope: string, limit: number, windowMs: number) {
  return async (c: Context, next: Next) => {
    const key = getClientKey(c, scope);
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || now > b.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      await next();
      return;
    }
    if (b.count >= limit) {
      return c.json(
        { ok: false, error: 'Too many requests', code: 'RATE_LIMITED' },
        429
      );
    }
    b.count += 1;
    await next();
  };
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.resetAt < now) buckets.delete(k);
  }
}, 60_000).unref();
