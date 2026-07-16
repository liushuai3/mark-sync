import type { Context, Next } from 'hono';

/**
 * Security headers middleware — adds defensive HTTP headers to every response.
 */
export function securityHeaders() {
  return async (c: Context, next: Next) => {
    // Content-Security-Policy: allow same-origin scripts/styles/images
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self'; frame-ancestors 'none'");
    // Prevent MIME sniffing
    c.header('X-Content-Type-Options', 'nosniff');
    // XSS filter
    c.header('X-Frame-Options', 'DENY');
    // Referrer policy
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    // Permissions policy
    c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    // Strict-Transport-Security (even on dev, harmless)
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    await next();
  };
}
