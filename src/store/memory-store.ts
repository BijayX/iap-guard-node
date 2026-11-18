import type { Platform } from '../core/types.js';
import type { PurchaseRecord, PurchaseStore } from './purchase-store.js';

const id = (platform: Platform, value: string) => `${platform}\u0000${value}`;

function copy(record: PurchaseRecord): PurchaseRecord {
  return { ...record, tokens: [...record.tokens] };
}

/**
 * In-memory `PurchaseStore` for tests, prototypes and single-process dev servers.
 * Every method checks and writes synchronously (no `await` in between), so `insert`,
 * `replace` and `rememberNotification` are atomic by construction. Not durable.
 */
export class MemoryPurchaseStore implements PurchaseStore {
  private readonly records = new Map<string, PurchaseRecord>();
  /** `(platform, token)` → record id. */
  private readonly tokens = new Map<string, string>();
  private readonly notifications = new Set<string>();

  findByKey(platform: Platform, key: string): Promise<PurchaseRecord | null> {
    const record = this.records.get(id(platform, key));
    return Promise.resolve(record ? copy(record) : null);
  }

  findByToken(platform: Platform, token: string): Promise<PurchaseRecord | null> {
    const recordId = this.tokens.get(id(platform, token));
    const record = recordId === undefined ? undefined : this.records.get(recordId);
    return Promise.resolve(record ? copy(record) : null);
  }

  findByUser(userId: string): Promise<PurchaseRecord[]> {
    const out = [...this.records.values()].filter((record) => record.userId === userId);
    return Promise.resolve(out.map(copy));
  }

  insert(record: PurchaseRecord): Promise<boolean> {
    const recordId = id(record.platform, record.key);
    if (this.records.has(recordId) || this.tokensTaken(record, recordId)) {
      return Promise.resolve(false);
    }
    this.write(recordId, record);
    return Promise.resolve(true);
  }

  replace(record: PurchaseRecord, expectedVersion: number): Promise<boolean> {
    const recordId = id(record.platform, record.key);
    const stored = this.records.get(recordId);
    if (stored?.version !== expectedVersion || this.tokensTaken(record, recordId)) {
      return Promise.resolve(false);
    }
    this.write(recordId, record);
    return Promise.resolve(true);
  }

  rememberNotification(platform: Platform, notificationId: string): Promise<boolean> {
    const key = id(platform, notificationId);
    if (this.notifications.has(key)) return Promise.resolve(false);
    this.notifications.add(key);
    return Promise.resolve(true);
  }

  forgetNotification(platform: Platform, notificationId: string): Promise<void> {
    this.notifications.delete(id(platform, notificationId));
    return Promise.resolve();
  }

  /** Number of stored purchase records. */
  get size(): number {
    return this.records.size;
  }

  /** Removes everything (tests). */
  clear(): void {
    this.records.clear();
    this.tokens.clear();
    this.notifications.clear();
  }

  private tokensTaken(record: PurchaseRecord, recordId: string): boolean {
    return record.tokens.some((token) => {
      const owner = this.tokens.get(id(record.platform, token));
      return owner !== undefined && owner !== recordId;
    });
  }

  private write(recordId: string, record: PurchaseRecord): void {
    this.records.set(recordId, copy(record));
    for (const token of record.tokens) this.tokens.set(id(record.platform, token), recordId);
  }
}
