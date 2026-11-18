import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  IapError,
  IapGuard,
  MemoryPurchaseStore,
  ValidationError,
  type ClaimInput,
} from '../../src/index.js';
import type { Handler } from '../helpers/fake-fetch.js';
import {
  ACCOUNT_SECRET,
  accountTokens,
  ackProductUrl,
  NOW,
  ackSubscriptionUrl,
  appleJws,
  googleRtdn,
  pushRequest,
  consumeUrl,
  googleApi,
  makeGuard,
  productUrl,
  rootPem,
  subscriptionUrl,
} from '../helpers/fixtures.js';

type Call = 'acknowledgeSubscription' | 'acknowledgeProduct' | 'consume' | null;

const withBody = (base: any, changes: Record<string, unknown>) => ({ ...base, ...changes });
const sub = googleApi.subscriptions;
const prod = googleApi.products;
const consumed = withBody(prod.consumable.body, {
  productLineItem: [
    {
      productId: 'coins_100',
      productOfferDetails: { quantity: 3, consumptionState: 'CONSUMPTION_STATE_CONSUMED' },
    },
  ],
});
const graceUnacknowledged = withBody(sub.gracePeriod.body, {
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
});

/** SPEC §7.7 matrix: [case, type, body, expected call, acknowledged after claim]. */
const MATRIX: [string, 'subscription' | 'one_time', any, Call, boolean][] = [
  [
    'active subscription, not acknowledged',
    'subscription',
    sub.active.body,
    'acknowledgeSubscription',
    true,
  ],
  [
    'active subscription, already acknowledged',
    'subscription',
    sub.activeAcknowledged.body,
    null,
    true,
  ],
  [
    'grace-period subscription, not acknowledged',
    'subscription',
    graceUnacknowledged,
    'acknowledgeSubscription',
    true,
  ],
  ['pending subscription', 'subscription', sub.pending.body, null, false],
  [
    'expired subscription',
    'subscription',
    withBody(sub.expired.body, { acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING' }),
    null,
    false,
  ],
  [
    'on-hold subscription',
    'subscription',
    withBody(sub.onHold.body, { acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING' }),
    null,
    false,
  ],
  [
    'non-consumable, not acknowledged',
    'one_time',
    prod.nonConsumable.body,
    'acknowledgeProduct',
    true,
  ],
  [
    'non-consumable, already acknowledged',
    'one_time',
    prod.nonConsumableAcknowledged.body,
    null,
    true,
  ],
  ['consumable (consume implies acknowledge)', 'one_time', prod.consumable.body, 'consume', true],
  ['consumable, already consumed', 'one_time', consumed, null, false],
  ['pending one-time purchase', 'one_time', prod.pending.body, null, false],
  ['cancelled one-time purchase', 'one_time', prod.cancelled.body, null, false],
];

function routesFor(
  type: 'subscription' | 'one_time',
  body: any,
  token: string,
  reply: Handler = { status: 200, body: {} },
) {
  const productId = (type === 'subscription' ? body.lineItems[0] : body.productLineItem[0])
    .productId as string;
  return {
    [`GET ${type === 'subscription' ? subscriptionUrl(token) : productUrl(token)}`]: {
      status: 200,
      body,
    },
    [`POST ${ackSubscriptionUrl(productId, token)}`]: reply,
    [`POST ${ackProductUrl(productId, token)}`]: reply,
    [`POST ${consumeUrl(productId, token)}`]: reply,
  };
}

function callKind(url: string): Call {
  if (url.endsWith(':consume')) return 'consume';
  if (url.includes('/purchases/subscriptions/')) return 'acknowledgeSubscription';
  return 'acknowledgeProduct';
}

describe('Google acknowledge / consume after claim (SPEC §7.7)', () => {
  it.each(MATRIX)('%s', async (_name, type, body, expected, acknowledged) => {
    const token = 'matrix-token';
    const { guard, store, fetch } = makeGuard({ routes: routesFor(type, body, token) });
    const result = await guard.claim({
      userId: 'user-1',
      platform: 'google',
      type,
      purchaseToken: token,
    });

    const posts = fetch.calls.filter(
      (call) => call.method === 'POST' && call.url.includes('androidpublisher'),
    );
    expect(posts.map((call) => callKind(call.url))).toEqual(expected ? [expected] : []);
    if (expected === 'consume') expect(posts[0]!.body).toBeUndefined();
    if (expected?.startsWith('acknowledge')) expect(posts[0]!.json).toEqual({});
    expect(result.purchase.acknowledged).toBe(acknowledged);
    const stored = await store.findByKey('google', token);
    expect(stored?.purchase.acknowledged).toBe(acknowledged);
  });

  it.each([
    ['acknowledge', 'subscription', sub.active.body],
    ['consume', 'one_time', prod.consumable.body],
  ] as const)(
    'a failed %s does not fail the claim; it is logged and retried by the next claim',
    async (action, type, body) => {
      const token = 'flaky-token';
      const routes = routesFor(type, body, token, [
        { status: 503, body: googleApi.errors.serverError.body },
        { status: 200, body: {} },
      ]);
      const { guard, logs } = makeGuard({ routes });
      const input: ClaimInput = {
        userId: 'user-1',
        platform: 'google',
        type,
        purchaseToken: token,
      };

      const first = await guard.claim(input);
      expect(first).toMatchObject({ ownership: 'created', isEntitled: true });
      expect(first.purchase.acknowledged).toBe(false);
      const warning = logs.find(
        (log) => log.level === 'warn' && log.message.includes(`${action} failed`),
      );
      expect(warning?.context).toEqual({
        platform: 'google',
        productId: first.purchase.productId,
        code: 'STORE_API_ERROR',
      });
      expect(JSON.stringify(logs)).not.toContain(token);

      const second = await guard.claim(input);
      expect(second.purchase.acknowledged).toBe(true);
    },
  );

  it('a network error during acknowledge is logged as NETWORK_ERROR and swallowed', async () => {
    const token = 'net-token';
    const { guard, logs } = makeGuard({
      routes: routesFor('subscription', sub.active.body, token, new Error('ECONNRESET')),
    });
    const result = await guard.claim({
      userId: 'u',
      platform: 'google',
      type: 'subscription',
      purchaseToken: token,
    });
    expect(result.purchase.acknowledged).toBe(false);
    expect(logs.find((log) => log.level === 'warn')?.context?.code).toBe('NETWORK_ERROR');
  });

  it('a failed versioned replace after acknowledging is ignored', async () => {
    const memory = new MemoryPurchaseStore();
    let replaces = 0;
    const store = Object.assign(Object.create(memory) as MemoryPurchaseStore, {
      replace: () => {
        replaces++;
        return Promise.resolve(false);
      },
    });
    const { guard } = makeGuard({
      storeOverride: store,
      routes: routesFor('subscription', sub.active.body, 't'),
    });
    const result = await guard.claim({
      userId: 'u',
      platform: 'google',
      type: 'subscription',
      purchaseToken: 't',
    });
    expect(result.purchase.acknowledged).toBe(false);
    expect(replaces).toBe(1);
  });

  it('Apple purchases are never acknowledged', async () => {
    const { guard, fetch } = makeGuard();
    const result = await guard.claim({
      userId: 'u',
      platform: 'apple',
      signedTransaction: appleJws.transactions.subscriptionActive.jws,
    });
    expect(result.purchase.acknowledged).toBeNull();
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('claimedAt and isNew (SPEC §7.3, §9)', () => {
  const coins: ClaimInput = {
    userId: 'user-1',
    platform: 'google',
    type: 'one_time',
    purchaseToken: 'gp-prod-token-coins',
  };
  const routes = routesFor('one_time', googleApi.products.consumable.body, 'gp-prod-token-coins');

  it('webhook first, then claim of a consumable → isNew=true; a second claim → false', async () => {
    const { guard, store } = makeGuard({ routes });
    await guard.handleGoogleNotification(
      pushRequest(googleRtdn.notifications.oneTimePurchased.body),
    );
    const stored = await store.findByKey('google', 'gp-prod-token-coins');
    expect(stored).toMatchObject({ userId: null, claimedAt: null });

    const first = await guard.claim(coins);
    expect(first).toMatchObject({ ownership: 'created', isNew: true });
    expect((await store.findByKey('google', 'gp-prod-token-coins'))?.claimedAt).toEqual(NOW);

    const second = await guard.claim(coins);
    expect(second).toMatchObject({ ownership: 'existing', isNew: false });
  });

  it('Apple ONE_TIME_CHARGE first, then claim → isNew=true once', async () => {
    const { guard } = makeGuard();
    await guard.handleAppleNotification(appleJws.notifications.oneTimeCharge.body);
    const input: ClaimInput = {
      userId: 'u',
      platform: 'apple',
      signedTransaction: appleJws.transactions.consumable.jws,
    };
    expect((await guard.claim(input)).isNew).toBe(true);
    expect((await guard.claim(input)).isNew).toBe(false);
  });

  it('releaseUser, then another user claims the consumable → isNew=false', async () => {
    const { guard, store } = makeGuard({ routes });
    expect((await guard.claim(coins)).isNew).toBe(true);
    expect(await guard.releaseUser('user-1')).toBe(1);
    const released = await store.findByKey('google', 'gp-prod-token-coins');
    expect(released).toMatchObject({ userId: null, claimedAt: NOW });

    const other = await guard.claim({ ...coins, userId: 'user-2' });
    expect(other).toMatchObject({ ownership: 'created', isNew: false });
  });

  it('a claim never clears claimedAt and webhooks never set it', async () => {
    const { guard, store } = makeGuard({ routes });
    await guard.claim(coins);
    await guard.handleGoogleNotification(
      pushRequest(googleRtdn.notifications.oneTimePurchased.body),
    );
    expect((await store.findByKey('google', 'gp-prod-token-coins'))?.claimedAt).toEqual(NOW);
  });
});

describe('claim', () => {
  it('throws CONCURRENT_MODIFICATION after three failed attempts', async () => {
    const memory = new MemoryPurchaseStore();
    let attempts = 0;
    const store = Object.assign(Object.create(memory) as MemoryPurchaseStore, {
      insert: () => {
        attempts++;
        return Promise.resolve(false);
      },
    });
    const { guard } = makeGuard({ storeOverride: store });
    const error = await guard
      .claim({
        userId: 'u',
        platform: 'apple',
        signedTransaction: appleJws.transactions.nonConsumable.jws,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IapError);
    expect(error).toMatchObject({ code: 'CONCURRENT_MODIFICATION', platform: 'apple' });
    expect(attempts).toBe(3);
  });

  it('retries a lost versioned replace and then succeeds', async () => {
    const memory = new MemoryPurchaseStore();
    let fail = 0;
    const store = Object.assign(Object.create(memory) as MemoryPurchaseStore, {
      replace: (record: never, version: number) =>
        fail++ === 0 ? Promise.resolve(false) : memory.replace(record, version),
    });
    const { guard } = makeGuard({ storeOverride: store });
    const input: ClaimInput = {
      userId: 'u',
      platform: 'apple',
      signedTransaction: appleJws.transactions.nonConsumable.jws,
    };
    await guard.claim(input);
    await expect(guard.claim(input)).resolves.toMatchObject({ ownership: 'existing' });
    expect(fail).toBe(2);
  });

  it('otherActive lists only the user’s other entitled purchases', async () => {
    const { guard } = makeGuard();
    const claim = (name: string) =>
      guard.claim({
        userId: 'u',
        platform: 'apple',
        signedTransaction: appleJws.transactions[name].jws,
      });
    await claim('lapsed'); // expired: not entitled
    await claim('nonConsumable');
    const result = await claim('subscriptionNoToken');
    expect(result.otherActive.map((p) => p.productId)).toEqual(['lifetime_unlock']);
  });

  it.each([
    ['an empty userId', ''],
    ['a userId over 191 characters', 'x'.repeat(192)],
    ['a non-string userId', 42],
  ])('rejects %s', async (_name, userId) => {
    const { guard } = makeGuard();
    const error = await guard
      .claim({ userId: userId as string, platform: 'apple', signedTransaction: 'a.b.c' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields.userId).toBeDefined();
  });

  it('accepts a userId of exactly 191 characters', async () => {
    const { guard } = makeGuard();
    await expect(
      guard.claim({
        userId: 'x'.repeat(191),
        platform: 'apple',
        signedTransaction: appleJws.transactions.nonConsumable.jws,
      }),
    ).resolves.toMatchObject({ ownership: 'created' });
  });

  it.each([
    ['no input', undefined, 'input'],
    ['an unknown platform', { platform: 'amazon' }, 'platform'],
    [
      'both apple proofs',
      { platform: 'apple', signedTransaction: 'a', transactionId: '1' },
      'signedTransaction',
    ],
    ['no apple proof', { platform: 'apple' }, 'signedTransaction'],
    [
      'an empty signedTransaction',
      { platform: 'apple', signedTransaction: '' },
      'signedTransaction',
    ],
    ['an empty transactionId', { platform: 'apple', transactionId: ' ' }, 'transactionId'],
    ['a bad google type', { platform: 'google', type: 'sub', purchaseToken: 't' }, 'type'],
    [
      'an empty purchaseToken',
      { platform: 'google', type: 'subscription', purchaseToken: '' },
      'purchaseToken',
    ],
    [
      'an empty productId',
      { platform: 'google', type: 'subscription', purchaseToken: 't', productId: '' },
      'productId',
    ],
  ])('verify rejects %s', async (_name, input, field) => {
    const { guard } = makeGuard();
    const error = await guard.verify(input as never).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(Object.keys((error as ValidationError).fields)).toContain(field);
  });

  it('requires a store', async () => {
    const guard = new IapGuard({
      apple: { bundleId: 'com.example.app', rootCertificates: [rootPem] },
    });
    await expect(
      guard.claim({
        userId: 'u',
        platform: 'apple',
        signedTransaction: appleJws.transactions.nonConsumable.jws,
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(guard.entitlements('u')).rejects.toBeInstanceOf(ConfigurationError);
    await expect(guard.releaseUser('u')).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe('entitlements / isEntitled / accountTokenFor', () => {
  it('sorts by expiresAt desc with never-expiring purchases first', async () => {
    const { guard } = makeGuard();
    for (const name of [
      'subscriptionUpgraded',
      'nonConsumable',
      'subscriptionNoToken',
      'nonRenewing',
    ]) {
      await guard.claim({
        userId: 'u',
        platform: 'apple',
        signedTransaction: appleJws.transactions[name].jws,
      });
    }
    // subscriptionUpgraded shares a key with nothing else here; expires in a year.
    const list = await guard.entitlements('u');
    expect(list.map((p) => p.productId)).toEqual([
      'lifetime_unlock',
      'season_pass',
      'premium_yearly',
      'premium_monthly',
    ]);
    // At a later "now" the 29-day subscription is gone.
    const later = await guard.entitlements('u', new Date('2027-01-01T00:00:00Z'));
    expect(later.map((p) => p.productId)).toEqual([
      'lifetime_unlock',
      'season_pass',
      'premium_yearly',
    ]);
  });

  it('accountTokenFor matches fixtures/account-tokens.json', () => {
    const { guard } = makeGuard({ accountTokenSecret: ACCOUNT_SECRET });
    for (const { userId, token } of accountTokens.cases) {
      expect(guard.accountTokenFor(userId)).toBe(token);
    }
  });

  it('accountTokenFor requires the secret', () => {
    const { guard } = makeGuard();
    expect(() => guard.accountTokenFor('u')).toThrow(ConfigurationError);
  });
});

describe('IapGuard configuration', () => {
  it.each([
    ['no config', undefined],
    ['no platform', {}],
    ['an unknown conflict policy', { apple: { bundleId: 'x' }, conflictPolicy: 'merge' }],
    ['a short accountTokenSecret', { apple: { bundleId: 'x' }, accountTokenSecret: 'short' }],
    ['a bad products list', { apple: { bundleId: 'x' }, products: ['ok', ''] }],
  ])('rejects %s', (_name, config) => {
    expect(() => new IapGuard(config as never)).toThrow(ConfigurationError);
  });
});
