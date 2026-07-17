import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import { config, isProd } from './config.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/error.js';
import { securityHeaders } from './middleware/security-headers.js';
import { bodySizeLimit } from './middleware/body-size-limit.js';
import { csrfProtection } from './middleware/csrf.js';
import auth, { ensureAdminUser } from './routes/auth.js';
import tokens from './routes/tokens.js';
import sync from './routes/sync.js';
import bookmarks from './routes/bookmarks.js';
import stats from './routes/stats.js';
import backups from './routes/backups.js';
import settings from './routes/settings.js';
import users from './routes/users.js';
import security from './routes/security.js';
import { startBackupScheduler } from './lib/backup.js';
import { startTombstoneCleanup } from './lib/tombstone-cleanup.js';
import { startSyncLogCleanup } from './lib/sync-log-cleanup.js';
import { existsSync } from 'node:fs';

const app = new Hono();

// Security headers on all responses
app.use('*', securityHeaders());

// Request body size limit (1MB for API, 10MB for sync)
app.use('/api/*', bodySizeLimit(1024 * 1024)); // 1MB general API
app.use('/api/sync/*', bodySizeLimit(10 * 1024 * 1024)); // 10MB for sync

// CSRF protection for non-safe methods
app.use('*', csrfProtection());

// CORS - allow configured origins + any chrome-extension://
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return '*';
      if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
        return origin;
      }
      if (config.corsOrigins.includes(origin)) return origin;
      // Loose fallback for prefix matches (e.g. chrome-extension:// prefix in config)
      for (const allowed of config.corsOrigins) {
        if (allowed.endsWith('://') && origin.startsWith(allowed)) return origin;
      }
      return null;
    },
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  })
);

// Simple access log
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const dur = Date.now() - start;
  logger.info(`${c.req.method} ${c.req.path} ${c.res.status} ${dur}ms`);
});

// Health check
app.get('/health', (c) => {
  return c.json({
    ok: true,
    data: {
      service: 'marksync-backend',
      version: '3.1.5',
      uptime: process.uptime(),
      time: Date.now(),
    },
  });
});

// API routes
app.route('/api/auth', auth);
app.route('/api/tokens', tokens);
app.route('/api/sync', sync);
app.route('/api/bookmarks', bookmarks);
app.route('/api/backups', backups);
app.route('/api/settings', settings);
app.route('/api/users', users);
app.route('/api/security', security);
app.route('/api', stats);

// Error handler
app.onError(errorHandler);

// Serve web static (production only)
const WEB_DIST = '../web/dist';
if (isProd && existsSync(WEB_DIST)) {
  logger.info(`Serving static files from ${WEB_DIST}`);
  // /downloads/* must be served before the catch-all, otherwise
  // missing zip files fall through to index.html (SPA fallback).
  app.use('/downloads/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('/downloads/*', serveStatic({ root: WEB_DIST }));
  app.use('/*', serveStatic({ root: WEB_DIST }));
  app.get('*', serveStatic({ path: `${WEB_DIST}/index.html` }));
}

serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: '0.0.0.0',
  },
  (info) => {
    logger.info(`MarkSync backend listening on http://0.0.0.0:${info.port} (${config.nodeEnv})`);
    startBackupScheduler();
    startTombstoneCleanup();
    startSyncLogCleanup();
    ensureAdminUser().catch((err) => logger.error('ensureAdminUser failed', err));
  }
);
