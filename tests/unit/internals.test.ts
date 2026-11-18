/**
 * Branches that the signed fixtures can't reach: the fixture CA keys were discarded, so new
 * Apple payloads can't be signed. Here only the signature step is mocked; everything after
 * it (app/environment checks, normalization, persistence) runs for real.
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryPurchaseStore, type Purchase, type PurchaseRecord } from '../../src/index.js';
import { resolveAppleConfig } from '../../src/apple/apple.config.js';
import { normalizeAppleTransaction } from '../../src/apple/apple.normalizer.js';
import { SignedDataVerifier } from '../../src/apple/signed-data-verifier.js';
import {
  normalizeGoogleProduct,
  normalizeGoogleSubscription,
} from '../../src/google/google.normalizer.js';
import { parseGooglePush } from '../../src/google/google.notifications.js';
import { releaseUser } from '../../src/ownership/release.js';
import { updateRecord, upsertFromNotification } from '../../src/ownership/upsert.js';
import type * as JwsModule from '../../src/crypto/jws.js';
import { NOW, appleJws, fixedClock, rootPem } from '../helpers/fixtures.js';

vi.mock('../../src/crypto/jws.js', async (importOriginal) => {
  const original = await importOriginal<typeof JwsModule>();
  return {
    ...original,
    // A token of the form "mock:<json>" decodes to <json>; anything else is verified for real.
    verifyX5cJws: (token: string, options: Parameters<typeof original.verifyX5cJws>[1]) =>
      token.startsWith('mock:')
        ? JSON.parse(token.slice(5))
        : original.verifyX5cJws(token, options),
  };
});

const mock = (payload: unknown) => `mock:${JSON.stringify(payload)}`;
const config = resolveAppleConfig({
  bundleId: 'com.example.app',
  appAppleId: 1234567890,
  rootCertificates: [rootPem],
});
const verifier = new SignedDataVerifier(config, fixedClock);
const base = {
  notificationType: 'RENEWAL_EXTENSION',
  notificationUUID: 'u-1',
  version: '2.0',
  signedDate: NOW.getTime(),
};

describe('SignedDataVerifier notifications (post-signature rules)', () => {
  it('accepts summary notifications (bundle/environment from summary)', () => {
    const result = verifier.verifyNotification(
      mock({ ...base, summary: { bundleId: 'com.example.app', environment: 'Sandbox' } }),
    );
    expect(result.environment).toBe('sandbox');
  });

  it.each([
    ['SANDBOX_abc', 'sandbox'],
    ['abc', 'production'],
  ])(
    'derives the environment of external purchase tokens (%s)',
    (externalPurchaseId, environment) => {
      const result = verifier.verifyNotification(
        mock({
          ...base,
          externalPurchaseToken: {
            externalPurchaseId,
            bundleId: 'com.example.app',
            appAppleId: 1234567890,
          },
        }),
      );
      expect(result.environment).toBe(environment);
    },
  );

  it.each([
    ['no app identifiers', { ...base }],
    ['no UUID', { ...base, notificationUUID: undefined, data: {} }],
    ['no type', { ...base, notificationType: 7, data: {} }],
  ])('rejects %s with INVALID_NOTIFICATION', (_name, payload) => {
    expect(() => verifier.verifyNotification(mock(payload))).toThrow(
      expect.objectContaining({ code: 'INVALID_NOTIFICATION' }),
    );
  });

  it('rejects renewal info from a disallowed environment', () => {
    const sandboxOnly = new SignedDataVerifier(
      resolveAppleConfig({
        bundleId: 'com.example.app',
        rootCertificates: [rootPem],
        environments: ['sandbox'],
      }),
      fixedClock,
    );
    expect(() => sandboxOnly.verifyRenewalInfo(appleJws.renewals.renewalActive.jws)).toThrow(
      expect.objectContaining({ code: 'ENVIRONMENT_NOT_ALLOWED' }),
    );
  });
});

describe('Apple normalizer branches', () => {
  const sub = appleJws.transactions.lapsed.payload;
  it.each([
    ['numeric 5 → revoked', {}, 5, 'revoked'],
    ['numeric 3 → billing_retry', {}, 3, 'billing_retry'],
    ['unknown numeric → computed', {}, 99, 'expired'],
    ['computed grace period', { gracePeriodExpiresDate: NOW.getTime() + 1 }, null, 'grace_period'],
    ['computed billing retry', { isInBillingRetryPeriod: true }, null, 'billing_retry'],
  ])('%s', (_name, renewal, status, expected) => {
    const purchase = normalizeAppleTransaction(
      { ...sub, signedDate: NOW.getTime() },
      { renewalInfo: { signedDate: 0, autoRenewStatus: 0, ...renewal }, status },
    );
    expect(purchase.status).toBe(expected);
    expect(purchase.willRenew).toBe(false);
    expect(purchase.autoRenewProductId).toBeNull();
  });

  it('defaults quantity, purchase date and original id', () => {
    const purchase = normalizeAppleTransaction({
      transactionId: '1',
      productId: 'p',
      type: 'Non-Consumable',
      signedDate: 5,
    });
    expect(purchase).toMatchObject({ quantity: 1, originalTransactionId: '1', key: '1' });
    expect(purchase.purchasedAt.getTime()).toBe(5);
  });
});

describe('Google normalizer branches', () => {
  it('canceled without expiry → expired, willRenew false', () => {
    const purchase = normalizeGoogleSubscription(
      't',
      { subscriptionState: 'SUBSCRIPTION_STATE_CANCELED', lineItems: [{ productId: 'p' }] },
      NOW,
    );
    expect(purchase).toMatchObject({
      status: 'expired',
      willRenew: false,
      expiresAt: null,
      transactionId: '',
    });
  });

  it('no plan → willRenew null; line items without product ids are kept as ""', () => {
    const purchase = normalizeGoogleSubscription('t', { lineItems: [{ productId: 'p' }, {}] }, NOW);
    expect(purchase).toMatchObject({ willRenew: null, status: 'expired', productIds: ['p', ''] });
  });

  it('unknown one-time state → canceled (fail closed)', () => {
    const purchase = normalizeGoogleProduct(
      't',
      { productLineItem: [{ productId: 'p' }], purchaseStateContext: { purchaseState: 'NEW' } },
      NOW,
      new Set(),
    );
    expect(purchase.status).toBe('canceled');
  });
});

describe('RTDN parsing', () => {
  it('rejects a body whose message.data is missing', () => {
    expect(() => parseGooglePush({ message: { messageId: '1' } })).toThrow(
      expect.objectContaining({ code: 'INVALID_NOTIFICATION' }),
    );
  });
  it('rejects a body that is not an object', () => {
    expect(() => parseGooglePush(null)).toThrow(
      expect.objectContaining({ code: 'INVALID_NOTIFICATION' }),
    );
  });
});

describe('optimistic concurrency in notification upserts and releases', () => {
  const purchase = normalizeAppleTransaction(appleJws.transactions.nonConsumable.payload);

  it('upsert retries a lost insert, then replaces', async () => {
    const memory = new MemoryPurchaseStore();
    let first = true;
    const store = Object.assign(Object.create(memory) as MemoryPurchaseStore, {
      insert: async (record: PurchaseRecord) => {
        if (first) {
          first = false;
          await memory.insert({ ...record, userId: 'someone' }); // another writer wins
          return false;
        }
        return memory.insert(record);
      },
    });
    const { record, stale } = await upsertFromNotification(store, fixedClock, purchase);
    expect(stale).toBe(false);
    expect(record).toMatchObject({ userId: 'someone', version: 2 });
  });

  it('upsert throws CONCURRENT_MODIFICATION after three lost replaces', async () => {
    const memory = new MemoryPurchaseStore();
    await memory.insert(record(purchase));
    const store = Object.assign(Object.create(memory) as MemoryPurchaseStore, {
      replace: () => Promise.resolve(false),
    });
    await expect(upsertFromNotification(store, fixedClock, purchase)).rejects.toMatchObject({
      code: 'CONCURRENT_MODIFICATION',
      platform: 'apple',
    });
  });

  it('updateRecord gives up after three lost replaces and returns null for missing records', async () => {
    const memory = new MemoryPurchaseStore();
    await memory.insert(record(purchase));
    const store = Object.assign(Object.create(memory) as MemoryPurchaseStore, {
      replace: () => Promise.resolve(false),
    });
    const load = () => store.findByKey('apple', purchase.key);
    await expect(
      updateRecord(store, fixedClock, load, () => ({ userId: null })),
    ).rejects.toMatchObject({
      code: 'CONCURRENT_MODIFICATION',
    });
    await expect(
      updateRecord(
        store,
        fixedClock,
        () => Promise.resolve(null),
        () => ({}),
      ),
    ).resolves.toBeNull();
  });

  it('releaseUser skips records whose owner changed in the meantime', async () => {
    const memory = new MemoryPurchaseStore();
    await memory.insert(record(purchase));
    const store = Object.assign(Object.create(memory) as MemoryPurchaseStore, {
      findByKey: async (platform: 'apple', key: string) => {
        const current = await memory.findByKey(platform, key);
        return current && { ...current, userId: 'someone-else' };
      },
    });
    expect(await releaseUser(store, fixedClock, 'u')).toBe(0);
  });
});

function record(purchase: Purchase): PurchaseRecord {
  return {
    platform: purchase.platform,
    key: purchase.key,
    userId: 'u',
    purchase,
    tokens: [],
    lastEventAt: purchase.signedAt,
    claimedAt: NOW,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
