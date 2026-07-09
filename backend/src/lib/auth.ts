import { SignJWT, jwtVerify } from 'jose';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { config } from '../config.js';
import { generateJwtSecret } from './crypto.js';

function loadJwtSecret(): Uint8Array {
  const path = config.jwtSecretPath;
  let hex: string;
  if (existsSync(path)) {
    hex = readFileSync(path, 'utf-8').trim();
  } else {
    hex = generateJwtSecret();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, hex, { mode: 0o600 });
    console.log(`[auth] Generated new JWT secret at ${path}`);
  }
  return new TextEncoder().encode(hex);
}

const jwtSecret = loadJwtSecret();

export async function signJwt(userId: number): Promise<string> {
  return await new SignJWT({ sub: String(userId) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(config.jwtExpiresIn)
    .sign(jwtSecret);
}

export async function verifyJwt(token: string): Promise<{ userId: number } | null> {
  try {
    const { payload } = await jwtVerify(token, jwtSecret);
    const userId = Number(payload.sub);
    if (!userId || isNaN(userId)) return null;
    return { userId };
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return await argonHash(password, {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password);
  } catch {
    return false;
  }
}
