import { Hono } from 'hono';
import { z } from 'zod';
import { db, now, type User } from '../db.js';
import { hashPassword, verifyPassword, signJwt, verifyJwt } from '../lib/auth.js';
import { config } from '../config.js';
import { requireJwt, requireAuth, type AuthContext } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { checkLoginThrottle, recordFailedLogin, recordSuccessfulLogin } from '../middleware/login-protection.js';
import { isMailerReady, sendVerificationEmail } from '../lib/mailer.js';

const app = new Hono();

const registerSchema = z.object({
  username: z.string().min(3).max(64),
  email: z.string().email().optional(),
  password: z.string().min(6).max(128),
  code: z.string().regex(/^\d{6}$/).optional(),
});

const PURPOSES = ['register', 'change_email', 'change_password', 'reset_password'] as const;
type MailPurpose = (typeof PURPOSES)[number];

const sendCodeSchema = z.object({
  email: z.string().email(),
  purpose: z.enum(PURPOSES).default('register'),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const passwordChangeSchema = z.object({
  old_password: z.string().min(1),
  new_password: z.string().min(6).max(128),
  code: z.string().regex(/^\d{6}$/).optional(),
});

const changeEmailSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
});

const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
  new_password: z.string().min(6).max(128),
});

const getUserByUsername = db.prepare<[string], User>('SELECT * FROM users WHERE username = ?');
const getUserById = db.prepare<[number], User>('SELECT * FROM users WHERE id = ?');
const countUsers = db.prepare<[], { c: number }>('SELECT COUNT(*) as c FROM users');
const insertUser = db.prepare(
  'INSERT INTO users (username, email, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const updatePasswordStmt = db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?');
const updateUserEmail = db.prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?');
const getDbSetting = db.prepare<[string], { value: string }>(
  'SELECT value FROM settings WHERE key = ? LIMIT 1'
);

const getUserByEmail = db.prepare<[string], User>('SELECT * FROM users WHERE email = ?');
const insertEmailCode = db.prepare(
  'INSERT INTO email_verifications (email, code, purpose, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const getLatestEmailCode = db.prepare<[string, string], {
  id: number;
  code: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  attempts: number;
}>(
  "SELECT id, code, created_at, expires_at, used_at, attempts FROM email_verifications WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1"
);
const markEmailCodeUsed = db.prepare('UPDATE email_verifications SET used_at = ? WHERE id = ?');
const incEmailCodeAttempts = db.prepare('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?');
const countRecentCodesForEmail = db.prepare<[string, string, number], { c: number }>(
  'SELECT COUNT(*) as c FROM email_verifications WHERE email = ? AND purpose = ? AND created_at > ?'
);
const countRecentCodesForIp = db.prepare<[string, number], { c: number }>(
  'SELECT COUNT(*) as c FROM email_verifications WHERE ip = ? AND created_at > ?'
);

app.post('/register', rateLimit('register', 3, 600_000), async (c) => {
  const parsed = registerSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { username, email, password, code } = parsed.data;

  const userCount = countUsers.get()?.c || 0;
  const isFirstUser = userCount === 0;

  // Check DB registration_open setting (no env fallback)
  if (!isFirstUser) {
    const dbSetting = getDbSetting.get('registration_open');
    if (!dbSetting || dbSetting.value !== 'true') {
      return c.json({ ok: false, error: 'Registration closed', code: 'REG_CLOSED' }, 403);
    }
  }

  if (getUserByUsername.get(username)) {
    return c.json({ ok: false, error: 'Username already exists', code: 'CONFLICT' }, 409);
  }

  // 强制邮箱验证码（首个管理员除外，防止初始化锁死）
  if (!isFirstUser && config.requireEmailVerification) {
    if (!email) {
      return c.json({ ok: false, error: '邮箱不能为空', code: 'EMAIL_REQUIRED' }, 400);
    }
    if (!code) {
      return c.json({ ok: false, error: '需要邮箱验证码', code: 'CODE_REQUIRED' }, 400);
    }
    if (getUserByEmail.get(email)) {
      return c.json({ ok: false, error: '邮箱已被注册', code: 'EMAIL_CONFLICT' }, 409);
    }
    const rec = getLatestEmailCode.get(email, 'register');
    const nowTs = now();
    if (!rec) {
      return c.json({ ok: false, error: '验证码不存在，请先获取', code: 'CODE_NOT_FOUND' }, 400);
    }
    if (rec.used_at) {
      return c.json({ ok: false, error: '验证码已使用，请重新获取', code: 'CODE_USED' }, 400);
    }
    if (rec.expires_at < nowTs) {
      return c.json({ ok: false, error: '验证码已过期，请重新获取', code: 'CODE_EXPIRED' }, 400);
    }
    if (rec.attempts >= 5) {
      return c.json({ ok: false, error: '验证码尝试次数过多，请重新获取', code: 'CODE_ATTEMPTS_EXCEEDED' }, 429);
    }
    if (rec.code !== code) {
      incEmailCodeAttempts.run(rec.id);
      return c.json({ ok: false, error: '验证码错误', code: 'CODE_MISMATCH' }, 400);
    }
    markEmailCodeUsed.run(nowTs, rec.id);
  }

  const passwordHash = await hashPassword(password);
  const ts = now();
  const info = insertUser.run(username, email || null, passwordHash, isFirstUser ? 1 : 0, ts, ts);
  const userId = Number(info.lastInsertRowid);

  const token = await signJwt(userId);
  const user = getUserById.get(userId)!;
  return c.json({
    ok: true,
    data: {
      user: publicUser(user),
      token,
    },
  });
});

// 发送邮箱验证码
app.post('/send-code', rateLimit('send-code', 3, 60_000), async (c) => {
  const parsed = sendCodeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ ok: false, error: '邮箱格式不合法', code: 'INVALID_INPUT' }, 400);
  }
  const { email, purpose } = parsed.data;

  if (!isMailerReady()) {
    return c.json({ ok: false, error: '服务器未配置 SMTP，无法发送邮件', code: 'SMTP_NOT_CONFIGURED' }, 503);
  }

  // 不同用途的前置校验
  if (purpose === 'register') {
    // 注册开关检查
    const userCount = countUsers.get()?.c || 0;
    if (userCount > 0) {
      const dbSetting = getDbSetting.get('registration_open');
      if (!dbSetting || dbSetting.value !== 'true') {
        return c.json({ ok: false, error: '注册已关闭', code: 'REG_CLOSED' }, 403);
      }
    }
    if (getUserByEmail.get(email)) {
      return c.json({ ok: false, error: '邮箱已被注册', code: 'EMAIL_CONFLICT' }, 409);
    }
  } else if (purpose === 'change_email') {
    // 需要登录，且目标邮箱未被其他人使用
    const authUser = await resolveJwtUser(c);
    if (!authUser) {
      return c.json({ ok: false, error: '未登录', code: 'UNAUTHORIZED' }, 401);
    }
    const existing = getUserByEmail.get(email);
    if (existing && existing.id !== authUser.id) {
      return c.json({ ok: false, error: '邮箱已被其他账号使用', code: 'EMAIL_CONFLICT' }, 409);
    }
    if (authUser.email && authUser.email === email) {
      return c.json({ ok: false, error: '新邮箱与当前邮箱相同', code: 'EMAIL_UNCHANGED' }, 400);
    }
  } else if (purpose === 'change_password') {
    // 需要登录，且邮箱必须与当前账号绑定一致
    const authUser = await resolveJwtUser(c);
    if (!authUser) {
      return c.json({ ok: false, error: '未登录', code: 'UNAUTHORIZED' }, 401);
    }
    if (!authUser.email) {
      return c.json({ ok: false, error: '当前账号未绑定邮箱，请先绑定', code: 'EMAIL_NOT_BOUND' }, 400);
    }
    if (authUser.email !== email) {
      return c.json({ ok: false, error: '邮箱与当前账号不匹配', code: 'EMAIL_MISMATCH' }, 400);
    }
  } else if (purpose === 'reset_password') {
    // 无需登录，邮箱必须属于某个账号（为防枚举，不存在也返回成功假象，但不实际发送）
    const target = getUserByEmail.get(email);
    if (!target) {
      // 不发送，但返回成功避免枚举
      return c.json({ ok: true, data: { sent: true, expires_in: 300, cooldown: 60 } });
    }
  }

  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    c.req.header('x-real-ip') ||
    c.req.header('CF-Connecting-IP') ||
    'unknown';

  const nowTs = now();

  // 单邮箱 60 秒冷却
  const last = getLatestEmailCode.get(email, purpose);
  if (last && nowTs - last.created_at < 60_000) {
    const wait = Math.ceil((60_000 - (nowTs - last.created_at)) / 1000);
    return c.json({ ok: false, error: `请 ${wait} 秒后再试`, code: 'COOLDOWN', data: { retry_after: wait } }, 429);
  }

  // 单邮箱 1 小时最多 5 次
  const perEmail = countRecentCodesForEmail.get(email, purpose, nowTs - 3600_000)?.c || 0;
  if (perEmail >= 5) {
    return c.json({ ok: false, error: '该邮箱今小时发送过多，稍后再试', code: 'RATE_LIMITED' }, 429);
  }
  // 单 IP 1 小时最多 10 次
  const perIp = countRecentCodesForIp.get(ip, nowTs - 3600_000)?.c || 0;
  if (perIp >= 10) {
    return c.json({ ok: false, error: '发送频率过高，稍后再试', code: 'RATE_LIMITED' }, 429);
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = nowTs + 5 * 60_000; // 5 分钟
  insertEmailCode.run(email, code, purpose, ip, nowTs, expiresAt);

  try {
    await sendVerificationEmail(email, code, purpose);
  } catch (err: any) {
    return c.json({ ok: false, error: '邮件发送失败，请稍后重试', code: 'MAIL_SEND_FAILED', detail: err?.message }, 500);
  }

  return c.json({ ok: true, data: { sent: true, expires_in: 300, cooldown: 60 } });
});

app.post('/login', rateLimit('login', 3, 60_000), async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { username, password } = parsed.data;

  // Extract IP for throttle check
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    c.req.header('x-real-ip') ||
    c.req.header('CF-Connecting-IP') ||
    'unknown';

  // Check brute-force protection
  const throttle = checkLoginThrottle(username, ip);
  if (throttle.blocked) {
    return c.json({ ok: false, error: throttle.reason, code: 'ACCOUNT_LOCKED' }, 429);
  }

  const user = getUserByUsername.get(username);
  if (!user) {
    // Still record to prevent username enumeration timing attacks
    recordFailedLogin(username, ip);
    return c.json({ ok: false, error: 'Invalid credentials', code: 'UNAUTHORIZED' }, 401);
  }
  const ok = await verifyPassword(user.password_hash, password);
  if (!ok) {
    recordFailedLogin(username, ip);
    return c.json({ ok: false, error: 'Invalid credentials', code: 'UNAUTHORIZED' }, 401);
  }
  recordSuccessfulLogin(username, ip);
  const token = await signJwt(user.id);
  return c.json({
    ok: true,
    data: { user: publicUser(user), token },
  });
});

app.get('/status', (c) => {
  const userCount = countUsers.get()?.c || 0;
  const dbSetting = getDbSetting.get('registration_open');
  const regOpen = !!dbSetting && dbSetting.value === 'true';
  return c.json({
    ok: true,
    data: {
      has_users: userCount > 0,
      registration_open: regOpen,
      can_register: userCount === 0 || regOpen,
      email_verification: config.requireEmailVerification && isMailerReady(),
      smtp_configured: isMailerReady(),
    },
  });
});

app.post('/logout', (c) => {
  return c.json({ ok: true, data: { logged_out: true } });
});

app.get('/me', requireAuth, (c) => {
  const user = c.get('user' as never) as User;
  return c.json({ ok: true, data: publicUser(user) });
});

app.put('/password', requireJwt, async (c) => {
  const user = c.get('user' as never) as User;
  const parsed = passwordChangeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { old_password, new_password, code } = parsed.data;
  const ok = await verifyPassword(user.password_hash, old_password);
  if (!ok) return c.json({ ok: false, error: 'Old password incorrect', code: 'UNAUTHORIZED' }, 401);

  // 如果用户绑定了邮箱，则强制邮箱验证
  if (user.email) {
    if (!code) {
      return c.json({ ok: false, error: '需要邮箱验证码', code: 'CODE_REQUIRED' }, 400);
    }
    const check = consumeEmailCode(user.email, 'change_password', code);
    if (check.error) {
      return c.json({ ok: false, error: check.error, code: check.codeStr }, check.status as any);
    }
  }

  const newHash = await hashPassword(new_password);
  updatePasswordStmt.run(newHash, now(), user.id);
  return c.json({ ok: true, data: { changed: true } });
});

// 修改邮箱（必须登录 + 新邮箱验证码）
app.put('/email', requireJwt, async (c) => {
  const user = c.get('user' as never) as User;
  const parsed = changeEmailSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { email, code } = parsed.data;

  if (user.email === email) {
    return c.json({ ok: false, error: '新邮箱与当前邮箱相同', code: 'EMAIL_UNCHANGED' }, 400);
  }
  const existing = getUserByEmail.get(email);
  if (existing && existing.id !== user.id) {
    return c.json({ ok: false, error: '邮箱已被其他账号使用', code: 'EMAIL_CONFLICT' }, 409);
  }

  const check = consumeEmailCode(email, 'change_email', code);
  if (check.error) {
    return c.json({ ok: false, error: check.error, code: check.codeStr }, check.status as any);
  }

  updateUserEmail.run(email, now(), user.id);
  const updated = getUserById.get(user.id)!;
  return c.json({ ok: true, data: publicUser(updated) });
});

// 忘记密码：无需登录，邮箱 + 验证码 + 新密码
app.post('/reset-password', rateLimit('reset-password', 5, 600_000), async (c) => {
  const parsed = resetPasswordSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' }, 400);
  }
  const { email, code, new_password } = parsed.data;
  const target = getUserByEmail.get(email);
  if (!target) {
    return c.json({ ok: false, error: '邮箱不存在或验证码错误', code: 'INVALID_INPUT' }, 400);
  }
  const check = consumeEmailCode(email, 'reset_password', code);
  if (check.error) {
    return c.json({ ok: false, error: check.error, code: check.codeStr }, check.status as any);
  }
  const newHash = await hashPassword(new_password);
  updatePasswordStmt.run(newHash, now(), target.id);
  return c.json({ ok: true, data: { reset: true } });
});

/**
 * Ensure admin user from env ADMIN_USERNAME / ADMIN_PASSWORD.
 * Called at startup.
 */
export async function ensureAdminUser(): Promise<void> {
  const username = config.adminUsername;
  const password = config.adminPassword;
  if (!username || !password) return;
  const existing = getUserByUsername.get(username);
  if (existing && existing.is_admin) return;
  if (existing) {
    db.prepare('UPDATE users SET is_admin = 1, updated_at = ? WHERE id = ?').run(now(), existing.id);
    return;
  }
  const passwordHash = await hashPassword(password);
  const ts = now();
  insertUser.run(username, null, passwordHash, 1, ts, ts);
}

function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    is_admin: !!u.is_admin,
    created_at: u.created_at,
  };
}

// 从 Authorization: Bearer <jwt> 提取当前用户，未登录返回 null（send-code 不能强制中间件，reset_password 无需登录）
async function resolveJwtUser(c: any): Promise<User | null> {
  const h = c.req.header('Authorization') || c.req.header('authorization');
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const raw = m[1].trim();
  if (raw.startsWith('mks_')) return null;
  const payload = await verifyJwt(raw);
  if (!payload) return null;
  return getUserById.get(payload.userId) ?? null;
}

// 验证邮箱验证码。成功返回 null，失败返回错误 Response
function consumeEmailCode(email: string, purpose: MailPurpose, code: string): { error?: string; codeStr?: string; status?: number } {
  const rec = getLatestEmailCode.get(email, purpose);
  const nowTs = now();
  if (!rec) return { error: '验证码不存在，请先获取', codeStr: 'CODE_NOT_FOUND', status: 400 };
  if (rec.used_at) return { error: '验证码已使用，请重新获取', codeStr: 'CODE_USED', status: 400 };
  if (rec.expires_at < nowTs) return { error: '验证码已过期，请重新获取', codeStr: 'CODE_EXPIRED', status: 400 };
  if (rec.attempts >= 5) return { error: '验证码尝试次数过多，请重新获取', codeStr: 'CODE_ATTEMPTS_EXCEEDED', status: 429 };
  if (rec.code !== code) {
    incEmailCodeAttempts.run(rec.id);
    return { error: '验证码错误', codeStr: 'CODE_MISMATCH', status: 400 };
  }
  markEmailCodeUsed.run(nowTs, rec.id);
  return {};
}

export default app;
