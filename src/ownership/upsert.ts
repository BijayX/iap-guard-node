import type { Clock } from '../core/clock.js';
import { IapError } from '../core/errors/index.js';
import { withChanges } from '../core/purchase.js';
import type { Purchase } from '../core/types.js';
import type { PurchaseRecord, PurchaseStore } from '../store/purchase-store.js';
import { MAX_ATTEMPTS, isNewerState, mergeTokens, resolveKey, tokensOf } from './record-state.js';

export interface UpsertResult {
  record: PurchaseRecord;
  stale: boolean;
}

/**
 * Applies state learned from a notification (SPEC §8): never changes `userId`, never rolls
 * state back. Unknown purchases are inserted unowned (`userId = null`) so the first matching
 * claim takes them.
 */
export async function upsertFromNotification(
  store: PurchaseStore,
  clock: Clock,
  verified: Purchase,
): Promise<UpsertResult> {
  const key = await resolveKey(store, verified);
  const purchase = key === verified.key ? verified : withChanges(verified, { key });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const now = clock();
    const record = await store.findByKey(purchase.platform, key);
    if (record === null) {
      const created: PurchaseRecord = {
        platform: purchase.platform,
        key,
        userId: null,
        purchase,
        tokens: tokensOf(purchase),
        lastEventAt: purchase.signedAt,
        claimedAt: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      if (await store.insert(created)) return { record: created, stale: false };
      continue;
    }
    if (!isNewerState(record, purchase)) return { record, stale: true };
    const next: PurchaseRecord = {
      ...record,
      purchase,
      lastEventAt: purchase.signedAt,
      tokens: mergeTokens(record.tokens, purchase),
      version: record.version + 1,
      updatedAt: now,
    };
    if (await store.replace(next, record.version)) return { record: next, stale: false };
  }
  throw concurrent(purchase);
}

/**
 * Applies a change to an existing record with a versioned replace, re-reading on conflict.
 * `change` returns null to leave the record as it is.
 */
export async function updateRecord(
  store: PurchaseStore,
  clock: Clock,
  load: () => Promise<PurchaseRecord | null>,
  change: (record: PurchaseRecord, now: Date) => Partial<PurchaseRecord> | null,
): Promise<PurchaseRecord | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const record = await load();
    if (record === null) return null;
    const now = clock();
    const changes = change(record, now);
    if (changes === null) return record;
    const next: PurchaseRecord = {
      ...record,
      ...changes,
      version: record.version + 1,
      updatedAt: now,
    };
    if (await store.replace(next, record.version)) return next;
  }
  throw new IapError(
    'CONCURRENT_MODIFICATION',
    'The purchase was modified concurrently; try again',
  );
}

function concurrent(purchase: Purchase): IapError {
  return new IapError(
    'CONCURRENT_MODIFICATION',
    'The purchase was modified concurrently; try again',
    {
      platform: purchase.platform,
    },
  );
}
