import { accountTokensMatch } from '../core/account-token.js';
import type { Clock } from '../core/clock.js';
import { IapError, OwnershipError } from '../core/errors/index.js';
import { isEntitled } from '../core/entitlement.js';
import { withChanges } from '../core/purchase.js';
import type { ClaimResult, ConflictPolicy, Ownership, Purchase } from '../core/types.js';
import type { PurchaseRecord, PurchaseStore } from '../store/purchase-store.js';
import { MAX_ATTEMPTS, isNewerState, mergeTokens, resolveKey, tokensOf } from './record-state.js';

export interface ClaimDependencies {
  store: PurchaseStore;
  clock: Clock;
  conflictPolicy: ConflictPolicy;
  /** Present when `accountTokenSecret` is configured. */
  accountTokenFor: ((userId: string) => string) | null;
  /** Google acknowledge/consume (SPEC §7.7); identity for Apple. */
  settle: (purchase: Purchase, record: PurchaseRecord) => Promise<PurchaseRecord>;
}

interface Outcome {
  ownership: Ownership;
  isNew: boolean;
  previousUserId: string | null;
}

/**
 * SPEC §7.3 steps 2–7 for an already verified purchase: resolve the ownership key, check the
 * account token, then record ownership with an atomic insert or a versioned replace,
 * retrying on conflicts.
 */
export async function claimVerifiedPurchase(
  deps: ClaimDependencies,
  userId: string,
  verified: Purchase,
): Promise<ClaimResult> {
  const { store, clock } = deps;
  const key = await resolveKey(store, verified);
  const purchase = key === verified.key ? verified : withChanges(verified, { key });

  if (
    deps.accountTokenFor !== null &&
    purchase.accountToken !== null &&
    !accountTokensMatch(purchase.accountToken, deps.accountTokenFor(userId)) &&
    deps.conflictPolicy === 'reject'
  ) {
    throw new OwnershipError('ACCOUNT_MISMATCH', 'This purchase was made for a different account', {
      platform: purchase.platform,
    });
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const now = clock();
    const record = await store.findByKey(purchase.platform, key);

    if (record === null) {
      const created: PurchaseRecord = {
        platform: purchase.platform,
        key,
        userId,
        purchase,
        tokens: tokensOf(purchase),
        lastEventAt: purchase.signedAt,
        claimedAt: now,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      if (!(await store.insert(created))) continue; // another device won the race
      return finish(deps, userId, purchase, created, {
        ownership: 'created',
        isNew: true,
        previousUserId: null,
      });
    }

    const outcome = ownershipOf(deps.conflictPolicy, record, userId, purchase);
    const newer = isNewerState(record, purchase);
    const next: PurchaseRecord = {
      ...record,
      userId,
      claimedAt: record.claimedAt ?? now,
      purchase: newer ? purchase : record.purchase,
      lastEventAt: newer ? purchase.signedAt : record.lastEventAt,
      tokens: mergeTokens(record.tokens, purchase),
      version: record.version + 1,
      updatedAt: now,
    };
    if (!(await store.replace(next, record.version))) continue; // optimistic concurrency
    return finish(deps, userId, purchase, next, outcome);
  }

  throw new IapError(
    'CONCURRENT_MODIFICATION',
    'The purchase was modified concurrently; try again',
    { platform: purchase.platform },
  );
}

function ownershipOf(
  policy: ConflictPolicy,
  record: PurchaseRecord,
  userId: string,
  purchase: Purchase,
): Outcome {
  // New = never claimed (only a webhook stored it, e.g. ONE_TIME_CHARGE / RTDN before the
  // app called claim) or this transaction/token was never seen by the record.
  const unseen =
    purchase.platform === 'apple'
      ? record.purchase.transactionId !== purchase.transactionId &&
        purchase.signedAt.getTime() > record.lastEventAt.getTime()
      : purchase.purchaseToken !== null && !record.tokens.includes(purchase.purchaseToken);
  const isNew = record.claimedAt === null || unseen;

  if (record.userId === null) return { ownership: 'created', isNew, previousUserId: null };
  if (record.userId === userId) return { ownership: 'existing', isNew, previousUserId: null };
  if (policy === 'reject') {
    // Never reveal who owns it.
    throw new OwnershipError('ALREADY_OWNED', 'This purchase belongs to another account', {
      platform: purchase.platform,
    });
  }
  return { ownership: 'transferred', isNew, previousUserId: record.userId };
}

async function finish(
  deps: ClaimDependencies,
  userId: string,
  verified: Purchase,
  written: PurchaseRecord,
  outcome: Outcome,
): Promise<ClaimResult> {
  const record = await deps.settle(verified, written);
  const now = deps.clock();
  const otherActive = (await deps.store.findByUser(userId))
    .filter((other) => !(other.platform === record.platform && other.key === record.key))
    .map((other) => other.purchase)
    .filter((other) => isEntitled(other, now));
  return {
    purchase: record.purchase,
    isEntitled: isEntitled(record.purchase, now),
    isNew: outcome.isNew,
    ownership: outcome.ownership,
    previousUserId: outcome.previousUserId,
    otherActive,
  };
}
