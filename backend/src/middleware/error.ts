import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from '../lib/logger.js';

export async function errorHandler(err: Error, c: Context) {
  if (err instanceof HTTPException) {
    const res = err.getResponse();
    if (res.headers.get('content-type')?.includes('application/json')) {
      return res;
    }
    return c.json(
      { ok: false, error: err.message, code: 'HTTP_ERROR' },
      err.status
    );
  }
  logger.error('Unhandled error:', err);
  return c.json(
    { ok: false, error: 'Internal server error', code: 'SERVER_ERROR' },
    500
  );
}
