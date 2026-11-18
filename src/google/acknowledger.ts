import type { Clock } from '../core/clock.js';
import { isIapError } from '../core/errors/index.js';
import { withChanges } from '../core/purchase.js';
import type { Logger, Purchase } from '../core/types.js';
import type { PurchaseRecord, PurchaseStore } from '../store/purchase-store.js';
import { isConsumed } from './google.normalizer.js';
import type { PlayDeveloperApi } from './play-developer-api.js';

/**
 * Google acknowledge / consume after a purchase is stored and owned (SPEC §7.7).
 * Failures never fail the caller: state is already stored, Play gives three days, and a
 * later claim or notification retries (both calls are idempotent).
 */
export class GoogleAcknowledger {
  constructor(
    private readonly api: PlayDeveloperApi,
    private readonly store: PurchaseStore,
    private readonly clock: Clock,
    private readonly logger?: Logger,
  ) {}

  /**
   * @param purchase freshly fetched state of the token to settle
   * @param record the stored record after this claim/notification was written
   * @returns the record, with `acknowledged = true` when settling succeeded and was saved
   */
  async settle(purchase: Purchase, record: PurchaseRecord): Promise<PurchaseRecord> {
    const token = purchase.purchaseToken;
    if (purchase.platform !== 'google' || token === null || record.userId === null) return record;
    if (purchase.status !== 'active' && purchase.status !== 'grace_period') return record;

    let action: 'consume' | 'acknowledge' | null = null;
    if (purchase.type === 'consumable') action = isConsumed(purchase) ? null : 'consume';
    else if (purchase.acknowledged === false) action = 'acknowledge';
    if (action === null) return record;

    try {
      if (action === 'consume') await this.api.consumeProduct(purchase.productId, token);
      else if (purchase.type === 'subscription') {
        await this.api.acknowledgeSubscription(purchase.productId, token);
      } else await this.api.acknowledgeProduct(purchase.productId, token);
    } catch (error) {
      this.logger?.warn(
        `iap-guard: google ${action} failed; will retry on the next claim or notification`,
        {
          platform: 'google',
          productId: purchase.productId,
          code: isIapError(error) ? error.code : 'UNKNOWN',
        },
      );
      return record;
    }

    // Best effort: record the new state only if the stored purchase is this token's.
    if (record.purchase.purchaseToken !== token || record.purchase.acknowledged === true)
      return record;
    const next: PurchaseRecord = {
      ...record,
      purchase: withChanges(record.purchase, { acknowledged: true }),
      version: record.version + 1,
      updatedAt: this.clock(),
    };
    return (await this.store.replace(next, record.version)) ? next : record;
  }
}
