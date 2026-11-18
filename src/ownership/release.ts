import type { Clock } from '../core/clock.js';
import type { PurchaseStore } from '../store/purchase-store.js';
import { updateRecord } from './upsert.js';

/**
 * Account deletion (SPEC §7.6): sets `userId = null` on the user's records so the same store
 * account can be restored into a new app account. Returns the number of records released.
 *
 * `claimedAt` is kept, so a released consumable claimed again by another account is not
 * `isNew` and is never granted twice.
 */
export async function releaseUser(
  store: PurchaseStore,
  clock: Clock,
  userId: string,
): Promise<number> {
  let released = 0;
  for (const owned of await store.findByUser(userId)) {
    const state = { changed: false };
    await updateRecord(
      store,
      clock,
      () => store.findByKey(owned.platform, owned.key),
      (record) => {
        state.changed = record.userId === userId;
        return state.changed ? { userId: null } : null;
      },
    );
    if (state.changed) released++;
  }
  return released;
}
