import type { Context, Next } from 'hono';
import { db, now } from '../db.js';
import { logger } from '../lib/logger.js';

// ─── Login attempt tracking ──────────────────────────────────────────────

type AttemptRecord = {
  failedCount: number;
  lockedUntil: number | null;
  lastFailedAt: number;
  ips: Set<string>;
  usernames: Set<string>;
};

const attempts = new Map<string, AttemptRecord>();

// Cleanup old records every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000; // 30 min
  for (const [key, rec] of attempts) {
    if (rec.lastFailedAt < cutoff && (!rec.lockedUntil || rec.lockedUntil < cutoff)) {
      attempts.delete(key);
    }
  }
}, 5 * 60_000).unref();

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 10 * 60_000; // 10 minutes

function getAttemptKey(username: string, ip: string): string {
  return `${username}:${ip}`;
}

function getGlobalKey(ip: string): string {
  return `global:${ip}`;
}

function getRecord(map: Map<string, AttemptRecord>, key: string): AttemptRecord {
  if (!map.has(key)) {
    map.set(key, { failedCount: 0, lockedUntil: null, lastFailedAt: 0, ips: new Set(), usernames: new Set() });
  }
  return map.get(key)!;
}

/**
 * Check if a login attempt should be blocked.
 * Returns { blocked: true, reason } or { blocked: false }.
 */
export function checkLoginThrottle(username: string, ip: string): { blocked: true; reason: string } | { blocked: false } {
  const userKey = getAttemptKey(username, ip);
  const globalKey = getGlobalKey(ip);

  const userRec = getRecord(attempts, userKey);
  const globalRec = getRecord(attempts, globalKey);

  // Track IP and username cross-references
  userRec.ips.add(ip);
  userRec.usernames.add(username);
  globalRec.ips.add(ip);
  globalRec.usernames.add(username);

  // Per-user+IP check
  if (userRec.lockedUntil && Date.now() < userRec.lockedUntil) {
    return { blocked: true, reason: '账户因多次登录失败已被临时锁定，请稍后再试' };
  }
  if (userRec.failedCount >= MAX_LOGIN_ATTEMPTS && !userRec.lockedUntil) {
    // Lock it
    userRec.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    logger.warn(`[security] User "${username}" locked out from IP ${ip} after ${MAX_LOGIN_ATTEMPTS} failed attempts`);
    return { blocked: true, reason: '账户因多次登录失败已被临时锁定，请稍后再试' };
  }

  // Global IP check (prevent brute force across usernames from same IP)
  if (globalRec.failedCount >= MAX_LOGIN_ATTEMPTS * 3 && !globalRec.lockedUntil) {
    globalRec.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
    logger.warn(`[security] IP ${ip} locked out after ${globalRec.failedCount} total failed attempts`);
    return { blocked: true, reason: '您的 IP 因过多登录尝试已被临时锁定，请稍后再试' };
  }

  return { blocked: false };
}

/**
 * Record a successful login — resets counters for this user+IP.
 */
export function recordSuccessfulLogin(username: string, ip: string): void {
  const key = getAttemptKey(username, ip);
  const rec = attempts.get(key);
  if (rec) {
    rec.failedCount = 0;
    rec.lockedUntil = null;
  }
}

/**
 * Record a failed login attempt.
 */
export function recordFailedLogin(username: string, ip: string): void {
  const userKey = getAttemptKey(username, ip);
  const globalKey = getGlobalKey(ip);

  const userRec = getRecord(attempts, userKey);
  const globalRec = getRecord(attempts, globalKey);

  userRec.failedCount += 1;
  userRec.lastFailedAt = Date.now();
  globalRec.failedCount += 1;
  globalRec.lastFailedAt = Date.now();

  // Log when approaching lockout threshold
  if (userRec.failedCount === MAX_LOGIN_ATTEMPTS - 1) {
    logger.warn(`[security] WARNING: User "${username}" from IP ${ip} has ${userRec.failedCount} failed attempts (1 more = lockout)`);
  }
}

/**
 * Get login attempt statistics for a username (for admin dashboard).
 */
export function getLoginStats(username?: string): {
  totalAttempts: number;
  lockedUsers: Array<{ username: string; lockedUntil: number | null }>;
  suspiciousIps: Array<{ ip: string; failedCount: number }>;
} {
  const lockedUsers: Array<{ username: string; lockedUntil: number | null }> = [];
  const suspiciousIps: Array<{ ip: string; failedCount: number }> = [];
  let totalAttempts = 0;

  for (const [key, rec] of attempts) {
    totalAttempts += rec.failedCount;
    if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
      for (const u of rec.usernames) {
        lockedUsers.push({ username: u, lockedUntil: rec.lockedUntil });
      }
    }
    if (rec.failedCount >= MAX_LOGIN_ATTEMPTS) {
      for (const ip of rec.ips) {
        suspiciousIps.push({ ip, failedCount: rec.failedCount });
      }
    }
  }

  // Deduplicate
  const seenUsers = new Set<string>();
  const dedupLocked = lockedUsers.filter((u: { username: string }) => {
    if (seenUsers.has(u.username)) return false;
    seenUsers.add(u.username);
    return true;
  });

  const seenIps = new Set<string>();
  const dedupIps = suspiciousIps.filter((i: { ip: string }) => {
    if (seenIps.has(i.ip)) return false;
    seenIps.add(i.ip);
    return true;
  });

  return {
    totalAttempts,
    lockedUsers: username
      ? dedupLocked.filter((u: { username: string }) => u.username === username)
      : dedupLocked,
    suspiciousIps: dedupIps,
  };
}
