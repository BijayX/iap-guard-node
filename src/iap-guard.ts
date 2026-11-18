import { ApplePurchaseVerifier } from './apple/apple-purchase-verifier.js';
import {
  resolveAppleConfig,
  type AppleConfig,
  type ResolvedAppleConfig,
} from './apple/apple.config.js';
import { decodeAppleNotification } from './apple/apple.notifications.js';
import { AppStoreServerApi } from './apple/app-store-server-api.js';
import { SignedDataVerifier } from './apple/signed-data-verifier.js';
import { MIN_ACCOUNT_TOKEN_SECRET_LENGTH, deriveAccountToken } from './core/account-token.js';
import { systemClock, type Clock } from './core/clock.js';
import { isEntitled, sortByExpiry } from './core/entitlement.js';
import {
  ConfigurationError,
  PurchaseNotFoundError,
  ValidationError,
  VerificationError,
} from './core/errors/index.js';
import { isRecord, nonEmpty } from './core/guards.js';
import { HttpClient, type HttpOptions } from './core/http/http-client.js';
import { withChanges } from './core/purchase.js';
import type {
  ClaimInput,
  ClaimResult,
  ConflictPolicy,
  Logger,
  NotificationEvent,
  NotificationResult,
  Platform,
  Purchase,
  VerifyInput,
  WebhookRequest,
} from './core/types.js';
import { GoogleAcknowledger } from './google/acknowledger.js';
import { GooglePurchaseVerifier } from './google/google-purchase-verifier.js';
import {
  resolveGoogleConfig,
  type GoogleConfig,
  type ResolvedGoogleConfig,
} from './google/google.config.js';
import { parseGooglePush, type ParsedGoogleNotification } from './google/google.notifications.js';
import { PlayDeveloperApi } from './google/play-developer-api.js';
import { PubSubVerifier } from './google/pubsub-verifier.js';
import { ServiceAccountAuth } from './google/service-account-auth.js';
import { claimVerifiedPurchase } from './ownership/claim.js';
import { releaseUser } from './ownership/release.js';
import { updateRecord, upsertFromNotification } from './ownership/upsert.js';
import type { PurchaseRecord, PurchaseStore } from './store/purchase-store.js';

export interface IapGuardConfig {
  apple?: AppleConfig;
  google?: GoogleConfig;
  /** Required for everything except `verify`. */
  store?: PurchaseStore;
  /** What happens when another user already owns a purchase. Default `'reject'`. */
  conflictPolicy?: ConflictPolicy;
  /** ≥ 32 characters. Enables `accountTokenFor()` and account-token checks in `claim`. */
  accountTokenSecret?: string | null;
  /** Optional allowlist of product ids (both platforms). */
  products?: readonly string[] | null;
  /** Timeouts, retries and an injectable `fetch`. */
  http?: HttpOptions;
  /** Receives debug/warn messages. Never receives secrets, tokens or other users' ids. */
  logger?: Logger;
  /** Source of "now". Default `() => new Date()`. */
  clock?: Clock;
}

interface AppleRuntime {
  config: ResolvedAppleConfig;
  signed: SignedDataVerifier;
  verifier: ApplePurchaseVerifier;
}

interface GoogleRuntime {
  config: ResolvedGoogleConfig;
  verifier: GooglePurchaseVerifier;
  pubsub: PubSubVerifier;
  api: PlayDeveloperApi;
}

type NotificationOutcome = Pick<NotificationResult, 'purchase' | 'userId' | 'stale'> & {
  event?: NotificationEvent;
};

const MAX_USER_ID_LENGTH = 191;
const CONFLICT_POLICIES: readonly ConflictPolicy[] = ['reject', 'transfer'];

/**
 * Server-side verification and ownership protection for App Store and Google Play purchases.
 *
 * ```ts
 * const guard = new IapGuard({ apple: { bundleId, appAppleId }, google: { packageName, serviceAccount }, store });
 * const result = await guard.claim({ userId, platform: 'apple', signedTransaction });
 * ```
 */
export class IapGuard {
  private readonly clock: Clock;
  private readonly store: PurchaseStore | null;
  private readonly conflictPolicy: ConflictPolicy;
  private readonly accountTokenSecret: string | null;
  private readonly logger: Logger | undefined;
  private readonly apple: AppleRuntime | null;
  private readonly google: GoogleRuntime | null;
  private readonly acknowledger: GoogleAcknowledger | null;

  constructor(config: IapGuardConfig) {
    const untrusted: unknown = config;
    if (!isRecord(untrusted)) throw new ConfigurationError('config is required');
    if (!config.apple && !config.google) {
      throw new ConfigurationError('Configure at least one platform (apple or google)');
    }
    this.clock = config.clock ?? systemClock;
    this.store = config.store ?? null;
    this.logger = config.logger;

    this.conflictPolicy = config.conflictPolicy ?? 'reject';
    if (!CONFLICT_POLICIES.includes(this.conflictPolicy)) {
      throw new ConfigurationError('conflictPolicy must be "reject" or "transfer"');
    }
    const secret = config.accountTokenSecret ?? null;
    if (
      secret !== null &&
      (typeof secret !== 'string' || secret.length < MIN_ACCOUNT_TOKEN_SECRET_LENGTH)
    ) {
      throw new ConfigurationError(
        `accountTokenSecret must be at least ${MIN_ACCOUNT_TOKEN_SECRET_LENGTH} characters`,
      );
    }
    this.accountTokenSecret = secret;
    const products = config.products ?? null;
    if (products !== null && (!Array.isArray(products) || !products.every(nonEmpty))) {
      throw new ConfigurationError('products must be an array of product ids');
    }
    const allowlist = products === null ? null : new Set(products);

    if (config.apple) {
      const resolved = resolveAppleConfig(config.apple);
      const signed = new SignedDataVerifier(resolved, this.clock);
      const api = resolved.api
        ? new AppStoreServerApi(
            resolved.api,
            resolved.bundleId,
            new HttpClient('apple', config.http, this.logger),
            this.clock,
          )
        : null;
      this.apple = {
        config: resolved,
        signed,
        verifier: new ApplePurchaseVerifier(resolved, signed, api, allowlist),
      };
    } else {
      this.apple = null;
    }

    if (config.google) {
      const resolved = resolveGoogleConfig(config.google);
      const http = new HttpClient('google', config.http, this.logger);
      const api = new PlayDeveloperApi(
        resolved,
        new ServiceAccountAuth(resolved, http, this.clock),
        http,
      );
      this.google = {
        config: resolved,
        api,
        verifier: new GooglePurchaseVerifier(resolved, api, allowlist, this.clock),
        pubsub: new PubSubVerifier(resolved, http, this.clock),
      };
    } else {
      this.google = null;
    }
    this.acknowledger =
      this.google && this.store
        ? new GoogleAcknowledger(this.google.api, this.store, this.clock, this.logger)
        : null;
  }

  // ---------------------------------------------------------------- verify / claim

  /** Proves a purchase is genuine and normalizes it (SPEC §5.4, §6.4). Needs no store. */
  async verify(input: VerifyInput): Promise<Purchase> {
    validateVerifyInput(input);
    if (input.platform === 'apple') return this.requireApple().verifier.verify(input);
    return this.requireGoogle().verifier.verify(input);
  }

  /**
   * Verifies a purchase and records it against `userId` (SPEC §7). Throws `OwnershipError`
   * when another user owns it (policy `reject`).
   */
  async claim(input: ClaimInput): Promise<ClaimResult> {
    validateUserId(isRecord(input) ? input.userId : undefined);
    const store = this.requireStore();
    const { userId, ...verifyInput } = input;
    const purchase = await this.verify(verifyInput);
    const secret = this.accountTokenSecret;
    return claimVerifiedPurchase(
      {
        store,
        clock: this.clock,
        conflictPolicy: this.conflictPolicy,
        accountTokenFor: secret === null ? null : (id) => deriveAccountToken(secret, id),
        settle: (fresh, record) => this.settle(fresh, record),
      },
      userId,
      purchase,
    );
  }

  // ---------------------------------------------------------------- notifications

  /**
   * App Store Server Notifications V2 (SPEC §8.1). Pass the request body (raw or parsed).
   * Use `toWebhookResponse()` to turn the result or error into an HTTP status.
   */
  async handleAppleNotification(body: unknown): Promise<NotificationResult> {
    const apple = this.requireApple();
    const store = this.requireStore();
    if (apple.config.environments.includes('production') && apple.config.appAppleId === null) {
      throw new ConfigurationError(
        'apple.appAppleId is required to handle production notifications',
        { platform: 'apple' },
      );
    }
    const decoded = decodeAppleNotification(apple.signed, body);
    return this.process('apple', decoded, decoded.payload, async () => {
      if (decoded.purchase === null) return { purchase: null, userId: null, stale: false };
      const { record, stale } = await upsertFromNotification(store, this.clock, decoded.purchase);
      return { purchase: record.purchase, userId: record.userId, stale };
    });
  }

  /**
   * Google Play RTDN delivered by a Pub/Sub push subscription (SPEC §8.2). Pass the raw or
   * parsed body plus headers (OIDC) or query (`?token=`). Current state is always fetched
   * from the Play Developer API — notification content beyond the token is never trusted.
   * Family-sharing, test-purchase and allowlist policies are enforced by `claim`, not here.
   */
  async handleGoogleNotification(request: WebhookRequest): Promise<NotificationResult> {
    const google = this.requireGoogle();
    this.requireStore();
    await google.pubsub.authenticate(request);
    const parsed = parseGooglePush(request.body);
    if (parsed.packageName !== google.config.packageName) {
      throw new VerificationError(
        'WRONG_APP',
        'Notification is for a different app (packageName)',
        {
          platform: 'google',
        },
      );
    }
    return this.process('google', parsed, parsed.notification, () => this.applyGoogle(parsed));
  }

  // ---------------------------------------------------------------- entitlements

  /** The user's purchases that grant access now, sorted by `expiresAt` desc (null first). */
  async entitlements(userId: string, now?: Date): Promise<Purchase[]> {
    validateUserId(userId);
    const at = now ?? this.clock();
    const records = await this.requireStore().findByUser(userId);
    return sortByExpiry(records.map((record) => record.purchase).filter((p) => isEntitled(p, at)));
  }

  /** SPEC §3 entitlement rule, using the configured clock by default. */
  isEntitled(purchase: Purchase, now?: Date): boolean {
    return isEntitled(purchase, now ?? this.clock());
  }

  /** Account deletion: frees the user's purchases for restore into another account. */
  async releaseUser(userId: string): Promise<number> {
    validateUserId(userId);
    return releaseUser(this.requireStore(), this.clock, userId);
  }

  /**
   * The UUID to pass as StoreKit `appAccountToken` / Play `obfuscatedAccountId` for this
   * user (SPEC §7.5). Requires `accountTokenSecret`.
   */
  accountTokenFor(userId: string): string {
    validateUserId(userId);
    if (this.accountTokenSecret === null) {
      throw new ConfigurationError('accountTokenSecret is required for account tokens');
    }
    return deriveAccountToken(this.accountTokenSecret, userId);
  }

  // ---------------------------------------------------------------- internals

  private async applyGoogle(parsed: ParsedGoogleNotification): Promise<NotificationOutcome> {
    const google = this.requireGoogle();
    const store = this.requireStore();
    const { action } = parsed;

    if (action.kind === 'none') return { purchase: null, userId: null, stale: false };

    if (action.kind === 'voided') {
      const record = await updateRecord(
        store,
        this.clock,
        () => store.findByToken('google', action.token),
        (current, now) =>
          action.partial
            ? null // quantity-based partial refund: keep status, still report the event
            : {
                purchase: withChanges(current.purchase, {
                  status: 'revoked',
                  revokedAt: now,
                  signedAt: now,
                }),
                lastEventAt: now,
              },
      );
      return { purchase: record?.purchase ?? null, userId: record?.userId ?? null, stale: false };
    }

    let fresh: Purchase;
    try {
      fresh = await google.verifier.fetch(
        action.kind === 'subscription' ? 'subscription' : 'one_time',
        action.token,
      );
    } catch (error) {
      // Nothing to retry: the token is unknown or expired long ago.
      if (error instanceof PurchaseNotFoundError)
        return { purchase: null, userId: null, stale: false };
      throw error;
    }
    if (action.kind === 'subscription' && action.forceRevoked) {
      fresh = withChanges(fresh, { status: 'revoked', revokedAt: this.clock() });
    }

    let event: NotificationEvent | undefined;
    if (
      parsed.rawType === 'SUBSCRIPTION_PURCHASED' &&
      fresh.linkedPurchaseToken !== null &&
      (await store.findByToken('google', fresh.linkedPurchaseToken)) !== null
    ) {
      event = 'plan_changed';
    }

    const { record, stale } = await upsertFromNotification(store, this.clock, fresh);
    const settled = await this.settle(fresh, record);
    return {
      purchase: settled.purchase,
      userId: settled.userId,
      stale,
      ...(event ? { event } : {}),
    };
  }

  /** Dedupe → work → result; forgets the notification when work throws (SPEC §8). */
  private async process(
    platform: Platform,
    parsed: { id: string; event: NotificationEvent; rawType: string },
    raw: Record<string, unknown>,
    work: () => Promise<NotificationOutcome>,
  ): Promise<NotificationResult> {
    const store = this.requireStore();
    const base = { platform, id: parsed.id, event: parsed.event, rawType: parsed.rawType, raw };
    if (!(await store.rememberNotification(platform, parsed.id))) {
      return { ...base, duplicate: true, stale: false, purchase: null, userId: null };
    }
    let outcome: NotificationOutcome;
    try {
      outcome = await work();
    } catch (error) {
      try {
        await store.forgetNotification(platform, parsed.id);
      } catch {
        this.logger?.warn('iap-guard: could not forget a failed notification', { platform });
      }
      throw error;
    }
    const { event, ...rest } = outcome;
    return { ...base, event: event ?? base.event, duplicate: false, ...rest };
  }

  private settle(purchase: Purchase, record: PurchaseRecord): Promise<PurchaseRecord> {
    return this.acknowledger ? this.acknowledger.settle(purchase, record) : Promise.resolve(record);
  }

  private requireApple(): AppleRuntime {
    if (!this.apple) throw new ConfigurationError('Apple is not configured', { platform: 'apple' });
    return this.apple;
  }

  private requireGoogle(): GoogleRuntime {
    if (!this.google)
      throw new ConfigurationError('Google is not configured', { platform: 'google' });
    return this.google;
  }

  private requireStore(): PurchaseStore {
    if (!this.store) throw new ConfigurationError('A PurchaseStore is required for this operation');
    return this.store;
  }
}

function validateUserId(userId: unknown): asserts userId is string {
  if (typeof userId !== 'string' || userId === '' || userId.length > MAX_USER_ID_LENGTH) {
    throw ValidationError.fromFields({
      userId: [`must be a non-empty string of at most ${MAX_USER_ID_LENGTH} characters`],
    });
  }
}

function validateVerifyInput(input: unknown): asserts input is VerifyInput {
  if (!isRecord(input)) throw ValidationError.fromFields({ input: ['must be an object'] });
  if (input.platform === 'apple') {
    const hasJws = input.signedTransaction !== undefined;
    const hasId = input.transactionId !== undefined;
    if (hasJws === hasId) {
      throw ValidationError.fromFields({
        signedTransaction: ['provide exactly one of signedTransaction or transactionId'],
      });
    }
    if (hasJws && !nonEmpty(input.signedTransaction)) {
      throw ValidationError.fromFields({ signedTransaction: ['must be a non-empty string'] });
    }
    if (hasId && !nonEmpty(input.transactionId)) {
      throw ValidationError.fromFields({ transactionId: ['must be a non-empty string'] });
    }
    return;
  }
  if (input.platform === 'google') {
    const fields: Record<string, string[]> = {};
    if (input.type !== 'subscription' && input.type !== 'one_time') {
      fields.type = ['must be "subscription" or "one_time"'];
    }
    if (!nonEmpty(input.purchaseToken)) fields.purchaseToken = ['must be a non-empty string'];
    if (input.productId !== undefined && !nonEmpty(input.productId)) {
      fields.productId = ['must be a non-empty string when given'];
    }
    if (Object.keys(fields).length > 0) throw ValidationError.fromFields(fields);
    return;
  }
  throw ValidationError.fromFields({ platform: ['must be "apple" or "google"'] });
}
