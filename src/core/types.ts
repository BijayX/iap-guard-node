/** Shared domain types (SPEC §3). Enum values are identical in the Node and Laravel packages. */

export type Platform = 'apple' | 'google';

export type ProductType =
  'subscription' | 'non_consumable' | 'consumable' | 'non_renewing_subscription';

/** Apple Sandbox and Google license-tester purchases are both `sandbox`. */
export type Environment = 'production' | 'sandbox';

export type PurchaseStatus =
  | 'pending'
  | 'active'
  | 'grace_period'
  | 'billing_retry'
  | 'paused'
  | 'expired'
  | 'revoked'
  | 'canceled';

export type Ownership = 'created' | 'existing' | 'transferred';

export type ConflictPolicy = 'reject' | 'transfer';

export type NotificationEvent =
  | 'purchased'
  | 'renewed'
  | 'recovered'
  | 'renewal_failed'
  | 'grace_period_started'
  | 'auto_renew_enabled'
  | 'auto_renew_disabled'
  | 'plan_changed'
  | 'expired'
  | 'refunded'
  | 'revoked'
  | 'refund_reversed'
  | 'paused'
  | 'canceled'
  | 'price_change'
  | 'consumption_request'
  | 'test'
  | 'other';

/** A verified, normalized purchase. Instances returned by this library are frozen. */
export interface Purchase {
  readonly platform: Platform;
  /** Ownership key (SPEC §2): stays the same across renewals, plan changes, restores and devices. */
  readonly key: string;
  readonly productId: string;
  readonly productIds: readonly string[];
  readonly type: ProductType;
  /** Status as of `signedAt`. Use `isEntitled()` for access decisions. */
  readonly status: PurchaseStatus;
  readonly environment: Environment;
  /** Apple `transactionId`; Google order id (may be `""` for pending purchases). */
  readonly transactionId: string;
  /** Apple only. */
  readonly originalTransactionId: string | null;
  /** Google only: the current purchase token. */
  readonly purchaseToken: string | null;
  /** Google subscriptions only. */
  readonly linkedPurchaseToken: string | null;
  readonly purchasedAt: Date;
  readonly expiresAt: Date | null;
  readonly gracePeriodExpiresAt: Date | null;
  readonly willRenew: boolean | null;
  /** Apple: product the subscription renews into (pending downgrade). */
  readonly autoRenewProductId: string | null;
  /** Apple `appAccountToken` / Google `obfuscatedExternalAccountId`. */
  readonly accountToken: string | null;
  readonly quantity: number;
  readonly familyShared: boolean;
  /** Google acknowledgement state; `null` on Apple. */
  readonly acknowledged: boolean | null;
  readonly revokedAt: Date | null;
  /** When this state was produced (Apple JWS `signedDate`; Google fetch time). */
  readonly signedAt: Date;
  /** Decoded store payload(s). Never contains this library's secrets. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Any object with `debug`/`warn` (and optionally `error`): `console`, pino, winston… */
export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error?(message: string, context?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------- inputs / results

/** StoreKit 2 `Transaction.jwsRepresentation` — preferred, verifiable offline. */
export interface AppleSignedTransactionInput {
  platform: 'apple';
  signedTransaction: string;
}

/** A transaction id looked up through the App Store Server API (requires `apple.api`). */
export interface AppleTransactionIdInput {
  platform: 'apple';
  transactionId: string;
}

export type AppleVerifyInput = AppleSignedTransactionInput | AppleTransactionIdInput;

export interface GoogleVerifyInput {
  platform: 'google';
  type: 'subscription' | 'one_time';
  purchaseToken: string;
  /** When given, the purchase must contain this product (else `PRODUCT_MISMATCH`). */
  productId?: string;
}

export type VerifyInput = AppleVerifyInput | GoogleVerifyInput;

export type ClaimInput = VerifyInput & {
  /** Your authenticated app user. Never take this from the request body. */
  userId: string;
};

export interface ClaimResult {
  /** Stored state after the claim (may be newer than the proof that was sent). */
  purchase: Purchase;
  isEntitled: boolean;
  /**
   * True only the first time this transaction/token is claimed by any user.
   * Grant consumables only when true.
   */
  isNew: boolean;
  ownership: Ownership;
  /** Set when `ownership === 'transferred'`: revoke access for this user. */
  previousUserId: string | null;
  /** This user's other entitled purchases (e.g. already subscribed on the other platform). */
  otherActive: Purchase[];
}

export interface NotificationResult {
  platform: Platform;
  /** Apple `notificationUUID`; Google Pub/Sub `message.messageId`. */
  id: string;
  event: NotificationEvent;
  /** e.g. `DID_RENEW/BILLING_RECOVERY`, `SUBSCRIPTION_RENEWED`. */
  rawType: string;
  /** Already processed: nothing else was done and `purchase` is null. */
  duplicate: boolean;
  /** Older than the stored state: the stored state was kept. */
  stale: boolean;
  /** Stored state after processing (null for test/duplicate/unknown notifications). */
  purchase: Purchase | null;
  /** Current owner, or null when nobody has claimed the purchase yet. */
  userId: string | null;
  raw: Readonly<Record<string, unknown>>;
}

/** Framework-agnostic view of an incoming webhook request. */
export interface WebhookRequest {
  /** Raw body (string/Buffer) or an already-parsed JSON object. */
  body: unknown;
  headers?: Headers | Record<string, string | string[] | undefined>;
  query?: URLSearchParams | Record<string, unknown>;
}
