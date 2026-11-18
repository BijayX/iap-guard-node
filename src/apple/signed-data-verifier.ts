import { PolicyError, VerificationError } from '../core/errors/index.js';
import type { Clock } from '../core/clock.js';
import { num, obj, str, type JsonObject } from '../core/guards.js';
import type { Environment } from '../core/types.js';
import { JwsError, verifyX5cJws } from '../crypto/jws.js';
import type { ResolvedAppleConfig } from './apple.config.js';

/** `signedDate` may be at most this far in the future (clock skew). */
const MAX_CLOCK_SKEW_MS = 60_000;

const APPLE_TYPES = new Set([
  'Auto-Renewable Subscription',
  'Non-Consumable',
  'Consumable',
  'Non-Renewing Subscription',
]);

export interface VerifiedNotification {
  payload: JsonObject;
  /** `data` or `summary`, whichever carried the app identifiers (may be empty). */
  data: JsonObject;
  environment: Environment;
}

/**
 * Verifies and decodes App Store signed data — transactions, renewal info and notifications —
 * against the configured trust anchors, bundle id, environments and app id (SPEC §5.2).
 */
export class SignedDataVerifier {
  constructor(
    private readonly config: ResolvedAppleConfig,
    private readonly clock: Clock,
  ) {}

  /** A `JWSTransaction` (StoreKit 2 `jwsRepresentation`, API or notification). */
  verifyTransaction(jws: unknown): JsonObject {
    const payload = this.decode(jws, 'transaction');
    if (
      str(payload.transactionId) === undefined ||
      str(payload.originalTransactionId) === undefined ||
      str(payload.productId) === undefined ||
      !APPLE_TYPES.has(str(payload.type) ?? '') ||
      num(payload.purchaseDate) === undefined
    ) {
      throw invalidSignature('signed transaction payload is missing required fields');
    }
    this.checkBundle(payload.bundleId);
    this.checkEnvironment(payload.environment);
    return payload;
  }

  /** A `JWSRenewalInfo`. */
  verifyRenewalInfo(jws: unknown): JsonObject {
    const payload = this.decode(jws, 'renewal info');
    this.checkEnvironment(payload.environment);
    return payload;
  }

  /** An App Store Server Notifications V2 `signedPayload`. */
  verifyNotification(jws: unknown): VerifiedNotification {
    const payload = this.decode(jws, 'notification');
    if (payload.version !== '2.0') {
      throw new VerificationError('INVALID_NOTIFICATION', 'Only notifications V2 are supported', {
        platform: 'apple',
      });
    }
    if (
      str(payload.notificationType) === undefined ||
      str(payload.notificationUUID) === undefined
    ) {
      throw new VerificationError('INVALID_NOTIFICATION', 'Notification type or UUID missing', {
        platform: 'apple',
      });
    }

    let data = obj(payload.data) ?? obj(payload.summary);
    let rawEnvironment: unknown = data?.environment;
    const external = obj(payload.externalPurchaseToken);
    if (!data && external) {
      // External purchase notifications carry no environment; Apple prefixes sandbox ids.
      data = external;
      rawEnvironment = str(external.externalPurchaseId)?.startsWith('SANDBOX')
        ? 'Sandbox'
        : 'Production';
    }
    if (!data) {
      throw new VerificationError('INVALID_NOTIFICATION', 'Notification has no app identifiers', {
        platform: 'apple',
      });
    }

    this.checkBundle(data.bundleId);
    const environment = this.checkEnvironment(rawEnvironment);
    if (
      environment === 'production' &&
      this.config.appAppleId !== null &&
      data.appAppleId !== this.config.appAppleId
    ) {
      throw new VerificationError('WRONG_APP', 'Notification is for a different app', {
        platform: 'apple',
      });
    }
    return { payload, data, environment };
  }

  private decode(jws: unknown, what: string): JsonObject {
    if (typeof jws !== 'string') throw invalidSignature(`signed ${what} is not a string`);
    try {
      return verifyX5cJws(jws, {
        roots: this.config.roots,
        now: this.clock(),
        maxClockSkewMs: MAX_CLOCK_SKEW_MS,
      });
    } catch (error) {
      /* v8 ignore next -- verifyX5cJws only throws JwsError */
      const reason = error instanceof JwsError ? error.message : 'verification failed';
      throw invalidSignature(`Invalid signed ${what}: ${reason}`, error);
    }
  }

  private checkBundle(bundleId: unknown): void {
    if (bundleId !== this.config.bundleId) {
      throw new VerificationError('WRONG_APP', 'Signed data is for a different app (bundleId)', {
        platform: 'apple',
      });
    }
  }

  private checkEnvironment(raw: unknown): Environment {
    const environment = toEnvironment(raw);
    if (!environment) throw invalidSignature('Signed data is not from the App Store');
    if (!this.config.environments.includes(environment)) {
      throw new PolicyError(
        'ENVIRONMENT_NOT_ALLOWED',
        `The ${environment} environment is not allowed`,
        { platform: 'apple', details: { environment } },
      );
    }
    return environment;
  }
}

/** "Production" / "Sandbox"; anything else (Xcode, LocalTesting) is not Apple-signed. */
export function toEnvironment(raw: unknown): Environment | null {
  if (raw === 'Production') return 'production';
  if (raw === 'Sandbox') return 'sandbox';
  return null;
}

function invalidSignature(message: string, cause?: unknown): VerificationError {
  return new VerificationError('INVALID_SIGNATURE', message, {
    platform: 'apple',
    ...(cause === undefined ? {} : { cause }),
  });
}
