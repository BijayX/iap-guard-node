import type { Purchase } from './types.js';

/**
 * Whether a purchase grants access at `now` (SPEC §3). Time-based, so a stored "active"
 * subscription stops granting access at `expiresAt` even if a webhook was missed.
 */
export function isEntitled(purchase: Purchase, now: Date): boolean {
  const at = now.getTime();
  if (purchase.status === 'active') {
    return purchase.expiresAt === null || purchase.expiresAt.getTime() > at;
  }
  if (purchase.status === 'grace_period') {
    const until = purchase.gracePeriodExpiresAt ?? purchase.expiresAt;
    return until === null || until.getTime() > at;
  }
  return false;
}

/** Sort by `expiresAt` descending, `null` (never expires) first. Stable. */
export function sortByExpiry(purchases: Purchase[]): Purchase[] {
  return [...purchases].sort((a, b) => {
    if (a.expiresAt === null) return b.expiresAt === null ? 0 : -1;
    if (b.expiresAt === null) return 1;
    return b.expiresAt.getTime() - a.expiresAt.getTime();
  });
}
