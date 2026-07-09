import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath: process.env.DB_PATH || './data/bookmarks.db',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  registrationOpen: process.env.REGISTRATION_OPEN === 'true',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL || 'info',
  jwtSecretPath: './data/jwt.secret',
};

export const isProd = config.nodeEnv === 'production';
