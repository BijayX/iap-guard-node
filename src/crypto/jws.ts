import type { JsonObject } from '../core/guards.js';
import { decodeJwt, verifySignature } from './jwt.js';
import { ChainError, verifyAppleChain, type TrustedRoot } from './x509-chain.js';

/** Why a JWS was rejected. Internal: callers map every failure to `INVALID_SIGNATURE`. */
export class JwsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwsError';
  }
}

export interface X5cJwsOptions {
  roots: readonly TrustedRoot[];
  now: Date;
  /** Reject `signedDate` further than this in the future. */
  maxClockSkewMs: number;
}

/**
 * Verifies an ES256 JWS whose signing key is carried in an `x5c` chain (SPEC §5.2 steps 1–8)
 * and returns the payload. The effective date for certificate validity is the payload's
 * `signedDate` (ms), as in Apple's library with online checks disabled.
 */
export function verifyX5cJws(token: string, options: X5cJwsOptions): JsonObject {
  const decoded = decodeJwt(token);
  if (!decoded) throw new JwsError('not a compact JWS with JSON header and payload');
  const { header, payload, signingInput, signature } = decoded;
  if (header.alg !== 'ES256') throw new JwsError('alg must be ES256');

  const signedDate = payload.signedDate;
  if (typeof signedDate !== 'number' || !Number.isFinite(signedDate)) {
    throw new JwsError('signedDate missing or not numeric');
  }
  if (signedDate > options.now.getTime() + options.maxClockSkewMs) {
    throw new JwsError('signedDate is in the future');
  }

  let leafKey;
  try {
    leafKey = verifyAppleChain(header.x5c, options.roots, new Date(signedDate));
  } catch (error) {
    throw new JwsError(error instanceof ChainError ? error.message : 'invalid certificate chain');
  }
  if (!verifySignature('ES256', signingInput, signature, leafKey)) {
    throw new JwsError('signature does not match');
  }
  return payload;
}
