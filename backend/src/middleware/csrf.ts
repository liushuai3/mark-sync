import type { Context, Next } from 'hono';

/**
 * CSRF protection for state-changing methods.
 *
 * Strategy:
 * 1. Requests with valid Authorization (Bearer JWT or API token) are exempt
 *    — they come from authenticated clients (extension, SPA, scripts).
 * 2. Requests without auth but with matching Origin are allowed
 *    — protects against cross-site form submission.
 * 3. Unauthenticated requests without Origin require X-CSRF-Token header.
 *
 * This approach is simpler and doesn't break the Chrome extension or SPA.
 */
export function csrfProtection() {
  return async (c: Context, next: Next) => {
    const method = c.req.method.toUpperCase();

    // Only protect state-changing methods
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next();
    }

    // If request has Bearer auth (JWT or API token), skip CSRF check
    // — authenticated requests are already protected by token validation
    const authHeader = c.req.header('Authorization') || c.req.header('authorization');
    if (authHeader && /^Bearer\s+/i.test(authHeader)) {
      return next();
    }

    // Check Origin header
    const origin = c.req.header('Origin') || c.req.header('origin');
    if (origin) {
      // If origin matches our own domain or known extensions, allow
      const hostname = c.req.header('host') || '';
      if (origin.includes(hostname) || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
        return next();
      }
      // Origin present but doesn't match — potential CSRF, reject
      return c.json(
        { ok: false, error: 'Invalid origin', code: 'CSRF_VALIDATION_FAILED' },
        403
      );
    }

    // No Origin, no auth — likely from curl/scripts. Require CSRF token.
    const csrfToken = c.req.header('X-CSRF-Token') || c.req.header('x-csrf-token');
    if (!csrfToken) {
      return c.json(
        { ok: false, error: 'CSRF token required', code: 'CSRF_MISSING' },
        403
      );
    }

    await next();
  };
}
