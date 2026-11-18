import type { Platform } from '../types.js';

/**
 * Stable, machine-readable error codes (SPEC §10). Match on `error.code` (or use `instanceof`)
 * instead of parsing messages — messages may change between releases.
 */
export const ErrorCode = {
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  STORE_API_ERROR: 'STORE_API_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  WRONG_APP: 'WRONG_APP',
  PRODUCT_MISMATCH: 'PRODUCT_MISMATCH',
  INVALID_NOTIFICATION: 'INVALID_NOTIFICATION',
  ENVIRONMENT_NOT_ALLOWED: 'ENVIRONMENT_NOT_ALLOWED',
  UNKNOWN_PRODUCT: 'UNKNOWN_PRODUCT',
  FAMILY_SHARING_NOT_ALLOWED: 'FAMILY_SHARING_NOT_ALLOWED',
  PURCHASE_NOT_FOUND: 'PURCHASE_NOT_FOUND',
  ALREADY_OWNED: 'ALREADY_OWNED',
  ACCOUNT_MISMATCH: 'ACCOUNT_MISMATCH',
  CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface IapErrorOptions {
  platform?: Platform | null;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * Base class for every error thrown by this library. Thrown directly only for
 * `CONCURRENT_MODIFICATION`.
 *
 * Private keys, access tokens, JWTs, the account-token secret and other users' ids are never
 * placed in `message` or `details`, so errors are safe to log and to return to clients.
 */
export class IapError extends Error {
  readonly code: ErrorCode;
  readonly platform: Platform | null;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, options: IapErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.platform = options.platform ?? null;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }

  /** Plain-object form for structured logging / API error responses. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      platform: this.platform,
      details: this.details,
    };
  }
}
