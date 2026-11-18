import { describe, expect, it } from 'vitest';
import { VerificationError } from '../../src/index.js';
import type { Handler } from '../helpers/fake-fetch.js';
import {
  NOW,
  ackProductUrl,
  ackSubscriptionUrl,
  consumeUrl,
  googleApi,
  googleRtdn,
  makeGuard,
  productRoute,
  productUrl,
  pushBody,
  pushRequest,
  serviceAccount,
  subscriptionRoute,
  subscriptionUrl,
} from '../helpers/fixtures.js';

/** Which api.json fixture answers for each token used by rtdn.json. */
const STATE_FOR_TOKEN: Record<string, [string, Handler]> = {
  'gp-sub-token-1': subscriptionRoute('activeAcknowledged'),
  'gp-sub-token-2': subscriptionRoute('upgraded'),
  'gp-sub-token-pending': subscriptionRoute('pendingCanceled'),
  'gp-prod-token-coins': productRoute('consumable'),
  'gp-prod-token-pending': productRoute('cancelled'),
};

const all = Object.entries<any>(googleRtdn.notifications);
const ok = all.filter(([, n]) => n.expected && n.expected.fetch !== null);

describe('RTDN with an API fetch (fixtures/google/rtdn.json)', () => {
  describe.each(ok)('%s', (name, fixture) => {
    it('fetches current state and maps event/rawType', async () => {
      const { expected } = fixture;
      const { guard, fetch } = makeGuard({
        routes: Object.fromEntries([STATE_FOR_TOKEN[expected.token]!]),
      });
      const result = await guard.handleGoogleNotification(pushRequest(fixture.body));

      const event = name === 'subscriptionUpgradePurchased' ? 'purchased' : expected.event; // chain not stored yet
      expect(result).toMatchObject({
        platform: 'google',
        id: fixture.body.message.messageId,
        event,
        rawType: expected.rawType,
        duplicate: false,
        stale: false,
        userId: null,
      });
      const url =
        expected.fetch === 'subscription'
          ? subscriptionUrl(expected.token)
          : productUrl(expected.token);
      expect(fetch.calls.filter((call) => call.url === url)).toHaveLength(1);
      expect(result.purchase?.purchaseToken).toBe(expected.token);
      if (expected.forceStatus) {
        expect(result.purchase).toMatchObject({ status: expected.forceStatus, revokedAt: NOW });
      }
      expect(result.raw).toMatchObject({ packageName: 'com.example.app' });
    });
  });

  it('subscriptionUpgradePurchased → plan_changed when the linked token is stored', async () => {
    const { guard } = makeGuard({
      routes: Object.fromEntries([
        subscriptionRoute('activeAcknowledged'),
        subscriptionRoute('upgraded'),
      ]),
    });
    await guard.handleGoogleNotification(
      pushRequest(googleRtdn.notifications.subscriptionPurchased.body),
    );
    const result = await guard.handleGoogleNotification(
      pushRequest(googleRtdn.notifications.subscriptionUpgradePurchased.body),
    );
    expect(result.event).toBe('plan_changed');
    expect(result.purchase).toMatchObject({
      key: 'gp-sub-token-1',
      purchaseToken: 'gp-sub-token-2',
    });
  });

  it.each(['notFound', 'gone', 'invalidToken'])(
    'API %s → purchase null, event still reported, no retry needed',
    async (error) => {
      const fixture = googleApi.errors[error];
      const { guard, store } = makeGuard({
        routes: {
          [`GET ${subscriptionUrl('gp-sub-token-1')}`]: {
            status: fixture.status,
            body: fixture.body,
          },
        },
      });
      const result = await guard.handleGoogleNotification(
        pushRequest(googleRtdn.notifications.subscriptionRenewed.body),
      );
      expect(result).toMatchObject({ event: 'renewed', purchase: null, userId: null });
      expect(store.size).toBe(0);
    },
  );

  it('API 5xx → error is thrown and the notification forgotten (Pub/Sub retries)', async () => {
    const { guard } = makeGuard({
      routes: {
        [`GET ${subscriptionUrl('gp-sub-token-1')}`]: [
          { status: 503, body: googleApi.errors.serverError.body },
          { status: 200, body: googleApi.subscriptions.active.body },
        ],
      },
    });
    const body = googleRtdn.notifications.subscriptionRenewed.body;
    await expect(guard.handleGoogleNotification(pushRequest(body))).rejects.toMatchObject({
      code: 'STORE_API_ERROR',
    });
    const retry = await guard.handleGoogleNotification(pushRequest(body));
    expect(retry).toMatchObject({ duplicate: false, event: 'renewed' });
  });

  it('does not apply the test-purchase policy (claim enforces it)', async () => {
    const { guard } = makeGuard({
      google: {
        packageName: 'com.example.app',
        serviceAccount,
        allowTestPurchases: false,
        pubsub: { verificationToken: googleRtdn.verificationToken },
      },
      routes: Object.fromEntries([subscriptionRoute('testPurchase', 'gp-sub-token-1')]),
    });
    const result = await guard.handleGoogleNotification({
      body: googleRtdn.notifications.subscriptionRenewed.body,
      query: { token: googleRtdn.verificationToken },
    });
    expect(result.purchase?.environment).toBe('sandbox');
    await expect(
      guard.claim({
        userId: 'u',
        platform: 'google',
        type: 'subscription',
        purchaseToken: 'gp-sub-token-1',
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_ALLOWED' });
  });
});

describe('RTDN without an API fetch', () => {
  it('test → event test, no API call, nothing stored', async () => {
    const { guard, fetch, store } = makeGuard();
    const result = await guard.handleGoogleNotification(
      pushRequest(googleRtdn.notifications.test.body),
    );
    expect(result).toMatchObject({ event: 'test', rawType: 'TEST', purchase: null });
    expect(fetch.callsTo('androidpublisher')).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it('pendingRefundReview → other / UNKNOWN', async () => {
    const { guard, fetch } = makeGuard();
    const result = await guard.handleGoogleNotification(
      pushRequest(googleRtdn.notifications.pendingRefundReview.body),
    );
    expect(result).toMatchObject({ event: 'other', rawType: 'UNKNOWN', purchase: null });
    expect(fetch.callsTo('androidpublisher')).toHaveLength(0);
  });

  it('unknown one-time notification type → other / UNKNOWN', async () => {
    const { guard } = makeGuard();
    const body = pushBody(
      {
        version: '1.0',
        packageName: 'com.example.app',
        eventTimeMillis: '1',
        oneTimeProductNotification: { notificationType: 9, purchaseToken: 't', sku: 'x' },
      },
      'm-1',
    );
    await expect(guard.handleGoogleNotification(pushRequest(body))).resolves.toMatchObject({
      event: 'other',
      rawType: 'UNKNOWN',
    });
  });

  describe.each([
    ['voidedFull', 'gp-prod-token-lifetime', 'revoked'],
    ['voidedSubscription', 'gp-sub-token-1', 'revoked'],
    ['voidedPartial', 'gp-prod-token-coins', 'active'],
  ])('%s', (name, token, status) => {
    it(`sets status=${status} on the stored record`, async () => {
      const { guard } = makeGuard({
        routes: Object.fromEntries([
          productRoute('nonConsumableAcknowledged'),
          subscriptionRoute('activeAcknowledged'),
          productRoute('consumable'),
          [`POST ${consumeUrl('coins_100', 'gp-prod-token-coins')}`, { status: 200, body: {} }],
        ]),
      });
      const type = token.startsWith('gp-sub') ? 'subscription' : 'one_time';
      await guard.claim({ userId: 'user-1', platform: 'google', type, purchaseToken: token });
      const fixture = googleRtdn.notifications[name];
      const result = await guard.handleGoogleNotification(pushRequest(fixture.body));
      expect(result).toMatchObject({
        event: 'refunded',
        rawType: 'VOIDED_PURCHASE',
        userId: 'user-1',
      });
      expect(result.purchase?.status).toBe(status);
      expect(result.purchase?.revokedAt).toEqual(status === 'revoked' ? NOW : null);
      expect(await guard.entitlements('user-1')).toHaveLength(status === 'revoked' ? 0 : 1);
    });
  });

  it('voided token that is not stored → purchase null, event refunded', async () => {
    const { guard } = makeGuard();
    const result = await guard.handleGoogleNotification(
      pushRequest(googleRtdn.notifications.voidedFull.body),
    );
    expect(result).toMatchObject({ event: 'refunded', purchase: null, userId: null });
  });
});

describe('RTDN errors', () => {
  describe.each(all.filter(([, n]) => n.expectedError))('%s', (_name, fixture) => {
    it(`fails with ${fixture.expectedError}`, async () => {
      const { guard } = makeGuard();
      const error = await guard
        .handleGoogleNotification(pushRequest(fixture.body))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VerificationError);
      expect(error).toMatchObject({ code: fixture.expectedError });
    });
  });

  it.each([
    ['a non-JSON raw body', '{oops'],
    ['a notification without packageName', pushBody({ testNotification: {} }, 'm-2')],
    [
      'a subscription notification without token',
      pushBody(
        { packageName: 'com.example.app', subscriptionNotification: { notificationType: 2 } },
        'm-3',
      ),
    ],
  ])('rejects %s with INVALID_NOTIFICATION', async (_name, body) => {
    const { guard } = makeGuard();
    await expect(guard.handleGoogleNotification(pushRequest(body))).rejects.toMatchObject({
      code: 'INVALID_NOTIFICATION',
    });
  });

  it('accepts a raw string body and message_id', async () => {
    const { guard } = makeGuard();
    const { messageId: _drop, ...message } = googleRtdn.notifications.test.body.message;
    const raw = JSON.stringify({ ...googleRtdn.notifications.test.body, message });
    await expect(guard.handleGoogleNotification(pushRequest(raw))).resolves.toMatchObject({
      id: message.message_id,
      event: 'test',
    });
  });
});

describe('RTDN dedupe and acknowledgement', () => {
  it('dedupes by Pub/Sub messageId', async () => {
    const { guard, fetch } = makeGuard({
      routes: Object.fromEntries([subscriptionRoute('activeAcknowledged')]),
    });
    const body = googleRtdn.notifications.subscriptionRenewed.body;
    await guard.handleGoogleNotification(pushRequest(body));
    const again = await guard.handleGoogleNotification(pushRequest(body));
    expect(again).toMatchObject({ duplicate: true, purchase: null });
    expect(fetch.callsTo('subscriptionsv2')).toHaveLength(1);
  });

  it('does not acknowledge an unowned purchase', async () => {
    const { guard, fetch } = makeGuard({
      routes: Object.fromEntries([subscriptionRoute('active')]),
    });
    const result = await guard.handleGoogleNotification(
      pushRequest(googleRtdn.notifications.subscriptionPurchased.body),
    );
    expect(result.purchase?.acknowledged).toBe(false);
    expect(fetch.callsTo(':acknowledge')).toHaveLength(0);
  });

  it('acknowledges an owned purchase whose earlier acknowledge failed', async () => {
    const { guard, fetch } = makeGuard({
      routes: {
        ...Object.fromEntries([subscriptionRoute('active')]),
        [`POST ${ackSubscriptionUrl('premium_monthly', 'gp-sub-token-1')}`]: [
          { status: 503, body: googleApi.errors.serverError.body },
          { status: 200, body: {} },
        ],
      },
    });
    const claim = await guard.claim({
      userId: 'user-1',
      platform: 'google',
      type: 'subscription',
      purchaseToken: 'gp-sub-token-1',
    });
    expect(claim.purchase.acknowledged).toBe(false);
    const result = await guard.handleGoogleNotification(
      pushRequest(googleRtdn.notifications.subscriptionRenewed.body),
    );
    expect(result.purchase?.acknowledged).toBe(true);
    expect(fetch.callsTo(':acknowledge')).toHaveLength(2);
  });

  it('one-time product acknowledge uses purchases/products', async () => {
    const { guard, fetch } = makeGuard({
      routes: {
        ...Object.fromEntries([productRoute('nonConsumable')]),
        [`POST ${ackProductUrl('lifetime_unlock', 'gp-prod-token-lifetime')}`]: {
          status: 200,
          body: {},
        },
      },
    });
    await guard.claim({
      userId: 'u',
      platform: 'google',
      type: 'one_time',
      purchaseToken: 'gp-prod-token-lifetime',
    });
    expect(fetch.callsTo(':acknowledge')[0]!.json).toEqual({});
  });
});

describe('upgraded chains', () => {
  it('ignores notifications about a replaced token', async () => {
    const { guard } = makeGuard({
      routes: Object.fromEntries([
        subscriptionRoute('expired'),
        subscriptionRoute('upgraded'),
        [
          `POST ${ackSubscriptionUrl('premium_yearly', 'gp-sub-token-2')}`,
          { status: 200, body: {} },
        ],
      ]),
    });
    await guard.claim({
      userId: 'user-1',
      platform: 'google',
      type: 'subscription',
      purchaseToken: 'gp-sub-token-1',
    });
    await guard.claim({
      userId: 'user-1',
      platform: 'google',
      type: 'subscription',
      purchaseToken: 'gp-sub-token-2',
    });

    const result = await guard.handleGoogleNotification(
      pushRequest(googleRtdn.notifications.subscriptionExpired.body),
    );

    expect(result.stale).toBe(true);
    expect(result.purchase).toMatchObject({ purchaseToken: 'gp-sub-token-2', status: 'active' });
    expect(await guard.entitlements('user-1')).toHaveLength(1);
  });
});
