import type { Context, Next } from 'hono';

/**
 * Request body size limit middleware.
 * Rejects requests with body larger than maxBytes.
 */
export function bodySizeLimit(maxBytes: number) {
  return async (c: Context, next: Next) => {
    const contentLength = c.req.header('content-length');
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (!isNaN(size) && size > maxBytes) {
        return c.json(
          { ok: false, error: `Request body too large (max ${maxBytes} bytes)`, code: 'PAYLOAD_TOO_LARGE' },
          413
        );
      }
    }
    await next();
  };
}
