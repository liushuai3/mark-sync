import { config } from '../config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const levels: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = levels[(config.logLevel as Level) || 'info'] ?? 1;

function log(level: Level, ...args: unknown[]) {
  if (levels[level] < threshold) return;
  const ts = new Date().toISOString();
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
  console[method](`[${ts}] [${level}]`, ...args);
}

export const logger = {
  debug: (...a: unknown[]) => log('debug', ...a),
  info: (...a: unknown[]) => log('info', ...a),
  warn: (...a: unknown[]) => log('warn', ...a),
  error: (...a: unknown[]) => log('error', ...a),
};
