import type { Platform, Purchase } from '../core/types.js';

/** One owned (or not yet claimed) purchase, keyed by `(platform, key)` (SPEC §9). */
export interface PurchaseRecord {
  readonly platform: Platform;
  /** Ownership key (SPEC §2). Unique per platform. */
  readonly key: string;
  /** Owner, or null when only a webhook has seen it or the owner was released. */
  readonly userId: string | null;
  /** Latest known state. */
  readonly purchase: Purchase;
  /** Google: every purchase token of the chain. Unique per platform across records. */
  readonly tokens: readonly string[];
  /** `signedAt` of the newest state applied; older proofs never roll state back. */
  readonly lastEventAt: Date;
  /**
   * First successful claim. Null for records only a webhook has stored. Never cleared (not even
   * by `releaseUser`), so a released consumable can't be granted again to another account.
   */
  readonly claimedAt: Date | null;
  /** Optimistic-concurrency version, starts at 1. */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Persistence used by `claim`, notifications and entitlements. `insert`, `replace` and
 * `rememberNotification` MUST be atomic — that is what makes "one owner per purchase" hold
 * when two devices claim at the same moment. See the SQL recipe in the README.
 */
export interface PurchaseStore {
  findByKey(platform: Platform, key: string): Promise<PurchaseRecord | null>;
  /** Google: the record whose `tokens` contains `token`. */
  findByToken(platform: Platform, token: string): Promise<PurchaseRecord | null>;
  findByUser(userId: string): Promise<PurchaseRecord[]>;
  /** False when `(platform, key)` — or one of `tokens` — already exists. */
  insert(record: PurchaseRecord): Promise<boolean>;
  /** False when the stored version is not `expectedVersion` (someone else wrote first). */
  replace(record: PurchaseRecord, expectedVersion: number): Promise<boolean>;
  /** False when `(platform, id)` was already remembered. */
  rememberNotification(platform: Platform, id: string): Promise<boolean>;
  forgetNotification(platform: Platform, id: string): Promise<void>;
}
