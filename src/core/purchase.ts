import type { Purchase } from './types.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Freezes a purchase (and its `productIds`) so stored state can't be mutated by accident. */
export function createPurchase(fields: Mutable<Purchase>): Purchase {
  return Object.freeze({ ...fields, productIds: Object.freeze([...fields.productIds]) });
}

/** A copy of `purchase` with some fields changed. */
export function withChanges(purchase: Purchase, changes: Partial<Mutable<Purchase>>): Purchase {
  return createPurchase({ ...purchase, ...changes });
}

const DATE_FIELDS = [
  'purchasedAt',
  'expiresAt',
  'gracePeriodExpiresAt',
  'revokedAt',
  'signedAt',
] as const;

/** JSON-safe form of a purchase: dates become ISO-8601 strings. Use it to persist purchases. */
export function serializePurchase(purchase: Purchase): Record<string, unknown> {
  const out: Record<string, unknown> = { ...purchase, productIds: [...purchase.productIds] };
  for (const field of DATE_FIELDS) {
    const value = purchase[field];
    out[field] = value === null ? null : value.toISOString();
  }
  return out;
}

/** Inverse of `serializePurchase` — for `PurchaseStore` implementations that store JSON. */
export function deserializePurchase(data: Record<string, unknown>): Purchase {
  const revive = (value: unknown): Date | null =>
    value === null || value === undefined ? null : new Date(value as string);
  const fields = { ...data } as unknown as Mutable<Purchase>;
  return createPurchase({
    ...fields,
    purchasedAt: revive(data.purchasedAt) ?? new Date(0),
    expiresAt: revive(data.expiresAt),
    gracePeriodExpiresAt: revive(data.gracePeriodExpiresAt),
    revokedAt: revive(data.revokedAt),
    signedAt: revive(data.signedAt) ?? new Date(0),
  });
}
