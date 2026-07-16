/**
 * @file uuid.js
 * @description UUID v4 generator for MarkSync client modules.
 *   Prefers the native `crypto.randomUUID()` when available (Chromium 92+,
 *   Firefox 95+); falls back to a manual RFC 4122 v4 implementation using
 *   `crypto.getRandomValues()` when present, or `Math.random()` as a last
 *   resort.
 * @see SRS-v3.0 §5.1 – client storage & id allocation
 */

/**
 * Generate a RFC 4122 v4 UUID.
 * @returns {string} A 36-char UUID string like `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.
 */
export function uuid() {
  // Preferred path: native crypto.randomUUID (secure, standards-compliant).
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // Fallback 1: manual v4 from crypto.getRandomValues (still cryptographically strong).
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // Per RFC 4122 §4.4: set version (4) and variant (10xx).
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [];
    for (let i = 0; i < 16; i++) {
      hex.push(bytes[i].toString(16).padStart(2, '0'));
    }
    return (
      hex.slice(0, 4).join('') +
      '-' +
      hex.slice(4, 6).join('') +
      '-' +
      hex.slice(6, 8).join('') +
      '-' +
      hex.slice(8, 10).join('') +
      '-' +
      hex.slice(10, 16).join('')
    );
  }

  // Fallback 2: Math.random (non-crypto; only reached in extremely old envs).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export default uuid;
