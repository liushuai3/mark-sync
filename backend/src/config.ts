import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath: process.env.DB_PATH || './data/bookmarks.db',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  adminUsername: process.env.ADMIN_USERNAME || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL || 'info',
  jwtSecretPath: './data/jwt.secret',
  backupDir: process.env.BACKUP_DIR || './data/backups',
  // Security settings
  maxRequestBodySize: Number(process.env.MAX_REQUEST_BODY_SIZE || 1048576), // 1MB default
};

export const isProd = config.nodeEnv === 'production';
