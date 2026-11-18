import { num, str, msDate, type JsonObject } from '../core/guards.js';
import { createPurchase } from '../core/purchase.js';
import type { ProductType, Purchase, PurchaseStatus } from '../core/types.js';

const TYPES: Readonly<Record<string, ProductType>> = {
  'Auto-Renewable Subscription': 'subscription',
  'Non-Consumable': 'non_consumable',
  Consumable: 'consumable',
  'Non-Renewing Subscription': 'non_renewing_subscription',
};

/** Numeric subscription status from notifications / `lastTransactions[].status`. */
const NUMERIC_STATUS: Readonly<Record<number, PurchaseStatus>> = {
  1: 'active',
  2: 'expired',
  3: 'billing_retry',
  4: 'grace_period',
  5: 'revoked',
};

export interface AppleNormalizeOptions {
  /** Verified `JWSRenewalInfo` payload, when available. */
  renewalInfo?: JsonObject | null;
  /** Numeric status (notification `data.status` / Server API `lastTransactions[].status`). */
  status?: number | null;
  /** Overrides `signedAt` (notifications use the notification's `signedDate`). */
  signedAt?: Date | null;
}

/** SPEC §4 status rules. */
function statusOf(
  tx: JsonObject,
  renewal: JsonObject | null,
  numeric: number | null,
  signedAt: number,
): PurchaseStatus {
  if (tx.revocationDate !== undefined && tx.revocationDate !== null) return 'revoked';
  if (tx.type !== 'Auto-Renewable Subscription') return 'active';
  if (numeric !== null && NUMERIC_STATUS[numeric] !== undefined) return NUMERIC_STATUS[numeric];
  const expires = num(tx.expiresDate);
  if (expires !== undefined && expires > signedAt) return 'active';
  const grace = num(renewal?.gracePeriodExpiresDate);
  if (grace !== undefined && grace > signedAt) return 'grace_period';
  if (renewal?.isInBillingRetryPeriod === true) return 'billing_retry';
  return 'expired';
}

/**
 * Normalizes a verified Apple transaction (+ optional renewal info) into a `Purchase`
 * (SPEC §3/§4). The caller must have verified both payloads.
 */
export function normalizeAppleTransaction(
  tx: JsonObject,
  options: AppleNormalizeOptions = {},
): Purchase {
  const renewal = options.renewalInfo ?? null;
  const signedAt =
    options.signedAt?.getTime() ?? Math.max(num(tx.signedDate) ?? 0, num(renewal?.signedDate) ?? 0);
  const type = TYPES[str(tx.type) ?? ''] ?? 'non_consumable';
  const isSubscription = type === 'subscription';
  const transactionId = str(tx.transactionId) ?? '';
  const originalTransactionId = str(tx.originalTransactionId) ?? transactionId;
  const productId = str(tx.productId) ?? '';
  const raw: Record<string, unknown> = { transaction: tx };
  if (renewal) raw.renewalInfo = renewal;
  if (options.status !== undefined && options.status !== null) raw.status = options.status;

  return createPurchase({
    platform: 'apple',
    key: type === 'consumable' ? transactionId : originalTransactionId,
    productId,
    productIds: [productId],
    type,
    status: statusOf(tx, renewal, options.status ?? null, signedAt),
    environment: tx.environment === 'Sandbox' ? 'sandbox' : 'production',
    transactionId,
    originalTransactionId,
    purchaseToken: null,
    linkedPurchaseToken: null,
    purchasedAt: msDate(tx.purchaseDate) ?? new Date(signedAt),
    expiresAt: msDate(tx.expiresDate),
    gracePeriodExpiresAt: msDate(renewal?.gracePeriodExpiresDate),
    willRenew: isSubscription && renewal ? renewal.autoRenewStatus === 1 : null,
    autoRenewProductId:
      isSubscription && renewal ? (str(renewal.autoRenewProductId) ?? null) : null,
    accountToken: str(tx.appAccountToken) ?? null,
    quantity: num(tx.quantity) ?? 1,
    familyShared: tx.inAppOwnershipType === 'FAMILY_SHARED',
    acknowledged: null,
    revokedAt: msDate(tx.revocationDate),
    signedAt: new Date(signedAt),
    raw: Object.freeze(raw),
  });
}
