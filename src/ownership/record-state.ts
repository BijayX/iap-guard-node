import type { Purchase } from '../core/types.js';
import type { PurchaseRecord, PurchaseStore } from '../store/purchase-store.js';

/** Attempts for optimistic-concurrency loops before `CONCURRENT_MODIFICATION`. */
export const MAX_ATTEMPTS = 3;

/**
 * Ownership key for a verified purchase (SPEC §7.3 step 2). A Google subscription joins an
 * existing chain through its `linkedPurchaseToken`, or through its own token when already
 * recorded; everything else keeps `purchase.key`.
 */
export async function resolveKey(store: PurchaseStore, purchase: Purchase): Promise<string> {
  if (purchase.platform !== 'google' || purchase.type !== 'subscription') return purchase.key;
  if (purchase.linkedPurchaseToken !== null) {
    const linked = await store.findByToken('google', purchase.linkedPurchaseToken);
    if (linked) return linked.key;
  }
  if (purchase.purchaseToken !== null) {
    const own = await store.findByToken('google', purchase.purchaseToken);
    if (own) return own.key;
  }
  return purchase.key;
}

/** Tokens a purchase contributes to its record: current and linked (Google only). */
export function tokensOf(purchase: Purchase): string[] {
  return [purchase.purchaseToken, purchase.linkedPurchaseToken].filter(
    (token): token is string => token !== null,
  );
}

export function mergeTokens(existing: readonly string[], purchase: Purchase): string[] {
  return [...new Set([...existing, ...tokensOf(purchase)])];
}

/**
 * Whether `purchase` may replace the stored state. Stale proofs never roll state back:
 * it must be at least as recent as `lastEventAt`, and for a Google subscription chain an
 * older token of the chain (already recorded, but not the current one) never overrides the
 * current token's state — after an upgrade the old token reports "expired".
 */
export function isNewerState(record: PurchaseRecord, purchase: Purchase): boolean {
  if (purchase.signedAt.getTime() < record.lastEventAt.getTime()) return false;
  if (purchase.platform === 'google' && purchase.type === 'subscription') {
    const token = purchase.purchaseToken;
    if (
      token !== null &&
      token !== record.purchase.purchaseToken &&
      record.tokens.includes(token)
    ) {
      return false;
    }
  }
  return true;
}
