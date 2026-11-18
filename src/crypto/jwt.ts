import {
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { isRecord, type JsonObject } from '../core/guards.js';
import { base64urlDecode, base64urlEncode } from './base64url.js';

export type JwtAlgorithm = 'ES256' | 'RS256';

export interface DecodedJwt {
  header: JsonObject;
  payload: JsonObject;
  /** `base64url(header) + "." + base64url(payload)` — the signed bytes. */
  signingInput: string;
  signature: Buffer;
}

/**
 * Splits a compact JWS/JWT into its parts. Returns null unless there are exactly three
 * base64url segments and header and payload are JSON objects.
 */
export function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const headerBytes = base64urlDecode(h);
  const payloadBytes = base64urlDecode(p);
  const signature = base64urlDecode(s);
  if (!headerBytes || !payloadBytes || !signature || h === '' || p === '') return null;
  const header = parseJson(headerBytes);
  const payload = parseJson(payloadBytes);
  if (!header || !payload) return null;
  return { header, payload, signingInput: `${h}.${p}`, signature };
}

function parseJson(bytes: Buffer): JsonObject | null {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Signs a JWT. ES256 signatures are raw `r||s` (IEEE P1363), as JOSE requires. */
export function signJwt(
  algorithm: JwtAlgorithm,
  header: JsonObject,
  payload: JsonObject,
  privateKey: KeyObject,
): string {
  const signingInput = `${base64urlEncode(JSON.stringify(header))}.${base64urlEncode(JSON.stringify(payload))}`;
  const signature = cryptoSign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    ...(algorithm === 'ES256' ? { dsaEncoding: 'ieee-p1363' as const } : {}),
  });
  return `${signingInput}.${base64urlEncode(signature)}`;
}

/**
 * Verifies a JWS signature. ES256 requires a P-256 key and a 64-byte `r||s` signature
 * (DER-encoded signatures are rejected); RS256 requires an RSA key.
 */
export function verifySignature(
  algorithm: JwtAlgorithm,
  signingInput: string,
  signature: Buffer,
  publicKey: KeyObject,
): boolean {
  try {
    if (algorithm === 'ES256') {
      if (signature.length !== 64) return false;
      if (publicKey.asymmetricKeyType !== 'ec') return false;
      if (publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
      return cryptoVerify(
        'sha256',
        Buffer.from(signingInput),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        signature,
      );
    }
    if (publicKey.asymmetricKeyType !== 'rsa') return false;
    return cryptoVerify('sha256', Buffer.from(signingInput), publicKey, signature);
  } catch {
    return false;
  }
}

/** JWK → public KeyObject, or null when the JWK is not a usable public key. */
export function jwkToPublicKey(jwk: unknown): KeyObject | null {
  if (!isRecord(jwk)) return null;
  try {
    return createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
  } catch {
    return null;
  }
}
