import { StoreApiError } from '../core/errors/index.js';
import { arr, isRecord, isoDate, num, obj, str, type JsonObject } from '../core/guards.js';
import { createPurchase } from '../core/purchase.js';
import type { Purchase, PurchaseStatus } from '../core/types.js';

const SUBSCRIPTION_STATES: Readonly<Record<string, PurchaseStatus>> = {
  SUBSCRIPTION_STATE_PENDING: 'pending',
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'grace_period',
  SUBSCRIPTION_STATE_ON_HOLD: 'billing_retry',
  SUBSCRIPTION_STATE_PAUSED: 'paused',
  SUBSCRIPTION_STATE_EXPIRED: 'expired',
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'canceled',
};

const PRODUCT_STATES: Readonly<Record<string, PurchaseStatus>> = {
  PURCHASED: 'active',
  PENDING: 'pending',
  CANCELLED: 'canceled',
};

function unexpected(body: JsonObject): StoreApiError {
  return new StoreApiError('Play Developer API response has no product', {
    platform: 'google',
    statusCode: 200,
    responseBody: body,
    retryable: false,
  });
}

/** `purchases.subscriptionsv2` → Purchase (SPEC §4). `key` is the token itself at this stage. */
export function normalizeGoogleSubscription(token: string, body: JsonObject, now: Date): Purchase {
  const items = arr(body.lineItems).filter(isRecord);
  const productIds = items.map((item) => str(item.productId) ?? '');
  const first = items[0];
  const productId = productIds[0];
  if (!first || !productId) throw unexpected(body);

  const expiries = items
    .map((item) => isoDate(item.expiryTime)?.getTime())
    .filter((ms): ms is number => ms !== undefined);
  const expiresAt = expiries.length > 0 ? new Date(Math.max(...expiries)) : null;

  const state = str(body.subscriptionState) ?? '';
  const canceled = state === 'SUBSCRIPTION_STATE_CANCELED';
  let status: PurchaseStatus = SUBSCRIPTION_STATES[state] ?? 'expired'; // unknown → fail closed
  if (canceled) {
    status = expiresAt !== null && expiresAt.getTime() > now.getTime() ? 'active' : 'expired';
  }

  const autoRenewingPlan = obj(first.autoRenewingPlan);
  let willRenew: boolean | null = autoRenewingPlan
    ? autoRenewingPlan.autoRenewEnabled === true
    : first.prepaidPlan !== undefined
      ? false
      : null;
  if (canceled) willRenew = false;

  return createPurchase({
    platform: 'google',
    key: token,
    productId,
    productIds,
    type: 'subscription',
    status,
    environment: body.testPurchase !== undefined ? 'sandbox' : 'production',
    transactionId: str(first.latestSuccessfulOrderId) ?? str(body.latestOrderId) ?? '',
    originalTransactionId: null,
    purchaseToken: token,
    linkedPurchaseToken: str(body.linkedPurchaseToken) ?? null,
    purchasedAt: isoDate(body.startTime) ?? now,
    expiresAt,
    gracePeriodExpiresAt: null,
    willRenew,
    autoRenewProductId: null,
    accountToken: str(obj(body.externalAccountIdentifiers)?.obfuscatedExternalAccountId) ?? null,
    quantity: 1,
    familyShared: false,
    acknowledged: body.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    revokedAt: null,
    signedAt: now,
    raw: Object.freeze({ ...body }),
  });
}

/** `purchases.productsv2` → Purchase (SPEC §4). */
export function normalizeGoogleProduct(
  token: string,
  body: JsonObject,
  now: Date,
  consumableProductIds: ReadonlySet<string>,
): Purchase {
  const items = arr(body.productLineItem).filter(isRecord);
  const productIds = items.map((item) => str(item.productId) ?? '');
  const first = items[0];
  const productId = productIds[0];
  if (!first || !productId) throw unexpected(body);

  const state = str(obj(body.purchaseStateContext)?.purchaseState) ?? '';
  return createPurchase({
    platform: 'google',
    key: token,
    productId,
    productIds,
    type: consumableProductIds.has(productId) ? 'consumable' : 'non_consumable',
    status: PRODUCT_STATES[state] ?? 'canceled', // unknown → fail closed
    environment: body.testPurchaseContext !== undefined ? 'sandbox' : 'production',
    transactionId: str(body.orderId) ?? '',
    originalTransactionId: null,
    purchaseToken: token,
    linkedPurchaseToken: null,
    purchasedAt: isoDate(body.purchaseCompletionTime) ?? now,
    expiresAt: null,
    gracePeriodExpiresAt: null,
    willRenew: null,
    autoRenewProductId: null,
    accountToken: str(body.obfuscatedExternalAccountId) ?? null,
    quantity: num(obj(first.productOfferDetails)?.quantity) ?? 1,
    familyShared: false,
    acknowledged: body.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    revokedAt: null,
    signedAt: now,
    raw: Object.freeze({ ...body }),
  });
}

/** Whether a one-time product line item was already consumed. */
export function isConsumed(purchase: Purchase): boolean {
  const first = arr(purchase.raw.productLineItem).find(isRecord);
  return obj(first?.productOfferDetails)?.consumptionState === 'CONSUMPTION_STATE_CONSUMED';
}
