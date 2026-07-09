import { createHash, randomBytes } from 'node:crypto';

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
