import { createHmac } from 'node:crypto';

/** Minimum length of `accountTokenSecret`. */
export const MIN_ACCOUNT_TOKEN_SECRET_LENGTH = 32;

/**
 * Deterministic UUID (version 8) for a user (SPEC §7.5):
 * `HMAC-SHA256(secret, "iap-guard:" + userId)`, first 16 bytes, version/variant bits set.
 * Reveals nothing about `userId` and cannot be forged without the secret.
 */
export function deriveAccountToken(secret: string, userId: string): string {
  const bytes = createHmac('sha256', secret)
    .update(`iap-guard:${userId}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x80, 6); // version 8 (custom)
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8); // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Account tokens compare case-insensitively (StoreKit upper-cases UUIDs). */
export function accountTokensMatch(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
