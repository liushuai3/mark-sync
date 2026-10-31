import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
  // HTTPS 双协议监听（可选）：三者齐全时额外启动 https server，http 保持不变
  httpsPort: Number(process.env.HTTPS_PORT || 0),
  tlsCertPath: process.env.TLS_CERT_PATH || '',
  tlsKeyPath: process.env.TLS_KEY_PATH || '',
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
  // SMTP settings (邮箱验证码)
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_SECURE ?? 'true') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
    fromName: process.env.SMTP_FROM_NAME || 'MarkSync',
  },
  requireEmailVerification: (process.env.REQUIRE_EMAIL_VERIFICATION ?? 'true') === 'true',
};

export const isProd = config.nodeEnv === 'production';
