import { createHash, randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function generateApiToken(): { token: string; hash: string; prefix: string } {
  const raw = randomBytes(16).toString('hex'); // 32 chars
  const token = `mks_${raw}`;
  const hash = sha256Hex(token);
  const prefix = token.slice(0, 12); // mks_ + 8 chars
  return { token, hash, prefix };
}

export function generateJwtSecret(): string {
  return randomBytes(32).toString('hex');
}

// ─── AES-256-GCM helpers ────────────────────────────────────────────────
// Master key is derived from a persistent secret file, colocated with jwt.secret.
// This lets us store reversible API tokens without checking a secret into git.

const SECRET_PATH = './data/token.key';

function ensureSecret(): Buffer {
  if (existsSync(SECRET_PATH)) {
    return readFileSync(SECRET_PATH);
  }
  mkdirSync(dirname(SECRET_PATH), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(SECRET_PATH, key, { mode: 0o600 });
  return key;
}

let _masterKey: Buffer | null = null;
function masterKey(): Buffer {
  if (_masterKey) return _masterKey;
  const seed = ensureSecret();
  _masterKey = scryptSync(seed, 'marksync-token-v1', 32);
  return _masterKey;
}

/**
 * Encrypt with AES-256-GCM. Returns base64 of iv || tag || ciphertext.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString('utf8');
}

// Reference config to avoid unused import warning when path constant kept for future config injection.
void config;
