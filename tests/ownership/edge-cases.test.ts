/**
 * SPEC §7.4 — one named test per edge case, in the same order as the README table.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  MemoryPurchaseStore,
  OwnershipError,
  type ClaimInput,
  type Platform,
} from '../../src/index.js';
import type { Handler } from '../helpers/fake-fetch.js';
import {
  ACCOUNT_SECRET,
  NOW,
  ackSubscriptionUrl,
  appleJws,
  consumeUrl,
  googleRtdn,
  makeGuard,
  productRoute,
  pushBody,
  pushRequest,
  rootPem,
  subscriptionRoute,
} from '../helpers/fixtures.js';

const tx = appleJws.transactions;
const apple = (name: string, userId: string): ClaimInput => ({
  userId,
  platform: 'apple',
  signedTransaction: tx[name].jws,
});
const googleSub = (token: string, userId: string): ClaimInput => ({
  userId,
  platform: 'google',
  type: 'subscription',
  purchaseToken: token,
});
const ok = (): Handler => ({ status: 200, body: {} });

describe('SPEC §7.4 edge cases', () => {
  it('#1 same user, second device (iPad after iPhone, or reinstall) restores → existing, isNew=false, entitled', async () => {
    const { guard } = makeGuard();
    const first = await guard.claim(apple('subscriptionActive', 'user-1'));
    const second = await guard.claim(apple('subscriptionActive', 'user-1'));
    expect(first).toMatchObject({ ownership: 'created', isNew: true, isEntitled: true });
    expect(second).toMatchObject({
      ownership: 'existing',
      isNew: false,
      isEntitled: true,
      previousUserId: null,
    });
  });

  it('#2 same user, subscribed on iOS, opens the Android app → entitlements() already includes the Apple subscription', async () => {
    const { guard, fetch } = makeGuard();
    await guard.claim(apple('subscriptionActive', 'user-1'));
    const entitlements = await guard.entitlements('user-1');
    expect(entitlements.map((p) => [p.platform, p.productId])).toEqual([
      ['apple', 'premium_monthly'],
    ]);
    expect(fetch.calls).toHaveLength(0); // no Google purchase or API call needed
  });

  describe('#3 two app accounts on one phone with one Apple ID / Google account: B restores A’s purchase', () => {
    it('reject (default) → ALREADY_OWNED without revealing the owner', async () => {
      const { guard } = makeGuard();
      await guard.claim(apple('subscriptionNoToken', 'user-A'));
      const error = await guard
        .claim(apple('subscriptionNoToken', 'user-B'))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OwnershipError);
      expect(error).toMatchObject({ code: 'ALREADY_OWNED' });
      expect(JSON.stringify(error) + (error as Error).message).not.toContain('user-A');
      expect(await guard.entitlements('user-A')).toHaveLength(1);
    });

    it('transfer → B owns it, previousUserId = A', async () => {
      const { guard } = makeGuard({ conflictPolicy: 'transfer' });
      await guard.claim(apple('subscriptionNoToken', 'user-A'));
      const result = await guard.claim(apple('subscriptionNoToken', 'user-B'));
      expect(result).toMatchObject({
        ownership: 'transferred',
        previousUserId: 'user-A',
        isNew: false,
      });
      expect(await guard.entitlements('user-A')).toHaveLength(0);
      expect(await guard.entitlements('user-B')).toHaveLength(1);
    });
  });

  describe('#4 same as #3 but the purchase carries A’s account token', () => {
    it('reject → ACCOUNT_MISMATCH, even before anyone has claimed it', async () => {
      const { guard, store } = makeGuard({ accountTokenSecret: ACCOUNT_SECRET });
      await expect(guard.claim(apple('subscriptionActive', 'user-2'))).rejects.toMatchObject({
        code: 'ACCOUNT_MISMATCH',
      });
      expect(store.size).toBe(0);
      await expect(guard.claim(apple('subscriptionActive', 'user-1'))).resolves.toMatchObject({
        ownership: 'created',
      });
    });

    it('transfer → the account-token check is skipped and normal ownership rules apply', async () => {
      const { guard } = makeGuard({
        accountTokenSecret: ACCOUNT_SECRET,
        conflictPolicy: 'transfer',
      });
      await guard.claim(apple('subscriptionActive', 'user-1'));
      await expect(guard.claim(apple('subscriptionActive', 'user-2'))).resolves.toMatchObject({
        ownership: 'transferred',
        previousUserId: 'user-1',
      });
    });

    it('purchases without a token (older app versions) skip the check', async () => {
      const { guard } = makeGuard({ accountTokenSecret: ACCOUNT_SECRET });
      await expect(guard.claim(apple('subscriptionNoToken', 'user-2'))).resolves.toMatchObject({
        ownership: 'created',
      });
    });

    it('applies to Google obfuscatedExternalAccountId too', async () => {
      const { guard } = makeGuard({
        accountTokenSecret: ACCOUNT_SECRET,
        routes: Object.fromEntries([subscriptionRoute('user2')]),
      });
      await expect(guard.claim(googleSub('gp-sub-token-user2', 'user-1'))).rejects.toMatchObject({
        code: 'ACCOUNT_MISMATCH',
      });
    });
  });

  it('#5 two devices of the same user claim at the same moment → one creates, the other sees existing; never two owners', async () => {
    const memory = new MemoryPurchaseStore();
    // Yield inside every read so both claims read "no record" before either inserts.
    const racing = Object.assign(Object.create(memory) as MemoryPurchaseStore, {
      findByKey: async (platform: Platform, key: string) => {
        const record = await memory.findByKey(platform, key);
        await new Promise((resolve) => setImmediate(resolve));
        return record;
      },
    });
    const insert = vi.spyOn(memory, 'insert');
    const { guard } = makeGuard({ storeOverride: racing });

    const results = await Promise.all([
      guard.claim(apple('subscriptionActive', 'user-1')),
      guard.claim(apple('subscriptionActive', 'user-1')),
    ]);
    expect(results.map((r) => r.ownership).sort()).toEqual(['created', 'existing']);
    expect(results.filter((r) => r.isNew)).toHaveLength(1);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(await Promise.all(insert.mock.results.map((r) => r.value))).toEqual([true, false]);
    expect(memory.size).toBe(1);

    // Two different users racing: exactly one wins.
    const settled = await Promise.allSettled([
      guard.claim(apple('nonConsumable', 'user-A')),
      guard.claim(apple('nonConsumable', 'user-B')),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((s) => s.status === 'rejected');
    expect(rejected?.reason).toMatchObject({ code: 'ALREADY_OWNED' });
  });

  it('#6 client replays an old consumable proof → isNew=false, no double grant', async () => {
    const { guard } = makeGuard({
      routes: Object.fromEntries([
        productRoute('consumable'),
        [`POST ${consumeUrl('coins_100', 'gp-prod-token-coins')}`, ok()],
      ]),
    });
    const first = await guard.claim(apple('consumable', 'user-1'));
    const replay = await guard.claim(apple('consumable', 'user-1'));
    expect([first.isNew, replay.isNew]).toEqual([true, false]);
    expect(first.purchase).toMatchObject({
      type: 'consumable',
      key: '2000000000000300',
      quantity: 2,
    });

    const google: ClaimInput = {
      userId: 'user-1',
      platform: 'google',
      type: 'one_time',
      purchaseToken: 'gp-prod-token-coins',
    };
    expect((await guard.claim(google)).isNew).toBe(true);
    expect((await guard.claim(google)).isNew).toBe(false);
  });

  it('#7 client sends an old (stale) subscription JWS after a newer one → ownership checks run, stored state is not rolled back', async () => {
    const { guard } = makeGuard();
    await guard.claim(apple('subscriptionActive', 'user-1'));
    const stale = await guard.claim(apple('subscriptionOld', 'user-1'));
    expect(stale).toMatchObject({ ownership: 'existing', isNew: false, isEntitled: true });
    expect(stale.purchase).toMatchObject({ transactionId: '2000000000000002', status: 'active' });
    await expect(guard.claim(apple('subscriptionOld', 'user-2'))).rejects.toMatchObject({
      code: 'ALREADY_OWNED',
    });
  });

  it('#8 Google upgrade/downgrade chains token-1 → token-2 → token-3: one record, one owner; the old token can’t be claimed by anyone else', async () => {
    const { guard, store } = makeGuard({
      routes: Object.fromEntries([
        subscriptionRoute('active'),
        subscriptionRoute('upgraded'),
        subscriptionRoute('upgradedAgain'),
        [`POST ${ackSubscriptionUrl('premium_monthly', 'gp-sub-token-1')}`, ok()],
        [`POST ${ackSubscriptionUrl('premium_yearly', 'gp-sub-token-2')}`, ok()],
        [`POST ${ackSubscriptionUrl('premium_family', 'gp-sub-token-3')}`, ok()],
      ]),
    });
    const r1 = await guard.claim(googleSub('gp-sub-token-1', 'user-1'));
    const r2 = await guard.claim(googleSub('gp-sub-token-2', 'user-1'));
    const r3 = await guard.claim(googleSub('gp-sub-token-3', 'user-1'));
    expect([r1.ownership, r2.ownership, r3.ownership]).toEqual(['created', 'existing', 'existing']);
    expect([r1.isNew, r2.isNew, r3.isNew]).toEqual([true, true, true]);
    expect(r3.purchase).toMatchObject({
      key: 'gp-sub-token-1',
      purchaseToken: 'gp-sub-token-3',
      productId: 'premium_family',
    });

    expect(store.size).toBe(1);
    const record = await store.findByKey('google', 'gp-sub-token-1');
    expect(record).toMatchObject({
      userId: 'user-1',
      tokens: ['gp-sub-token-1', 'gp-sub-token-2', 'gp-sub-token-3'],
    });
    expect(await store.findByToken('google', 'gp-sub-token-2')).toMatchObject({
      key: 'gp-sub-token-1',
    });

    for (const token of ['gp-sub-token-1', 'gp-sub-token-2', 'gp-sub-token-3']) {
      await expect(guard.claim(googleSub(token, 'user-2'))).rejects.toMatchObject({
        code: 'ALREADY_OWNED',
      });
    }
    // Re-claiming an old token of the chain never replaces the current token's state.
    const again = await guard.claim(googleSub('gp-sub-token-2', 'user-1'));
    expect(again).toMatchObject({ ownership: 'existing', isNew: false });
    expect(again.purchase.purchaseToken).toBe('gp-sub-token-3');
    expect(store.size).toBe(1);
  });

  it('#8 an old token of the chain never rolls back the current state (Play reports it expired after an upgrade)', async () => {
    const { guard } = makeGuard({
      routes: Object.fromEntries([
        subscriptionRoute('expired'),
        subscriptionRoute('upgraded'),
        [`POST ${ackSubscriptionUrl('premium_yearly', 'gp-sub-token-2')}`, ok()],
      ]),
    });
    await guard.claim(googleSub('gp-sub-token-1', 'user-1'));
    await guard.claim(googleSub('gp-sub-token-2', 'user-1'));

    const again = await guard.claim(googleSub('gp-sub-token-1', 'user-1'));

    expect(again).toMatchObject({ ownership: 'existing', isNew: false, isEntitled: true });
    expect(again.purchase).toMatchObject({
      purchaseToken: 'gp-sub-token-2',
      productId: 'premium_yearly',
      status: 'active',
    });
  });

  it('#9 Apple upgrade/downgrade within a subscription group → same originalTransactionId, same record', async () => {
    const { guard, store } = makeGuard();
    await guard.claim(apple('subscriptionActive', 'user-1'));
    const upgraded = await guard.claim(apple('subscriptionUpgraded', 'user-1'));
    expect(upgraded).toMatchObject({ ownership: 'existing', isNew: true });
    expect(upgraded.purchase).toMatchObject({
      key: '2000000000000001',
      productId: 'premium_yearly',
    });
    expect(store.size).toBe(1);
  });

  it('#10 Apple Family Sharing → own originalTransactionId, familyShared=true; disable with allowFamilySharing=false', async () => {
    const { guard } = makeGuard();
    const result = await guard.claim(apple('familyShared', 'family-member'));
    expect(result.purchase).toMatchObject({ familyShared: true, key: '2000000000000400' });

    const { guard: strict } = makeGuard({
      apple: {
        bundleId: 'com.example.app',
        rootCertificates: [rootPem],
        allowFamilySharing: false,
      },
    });
    await expect(strict.claim(apple('familyShared', 'family-member'))).rejects.toMatchObject({
      code: 'FAMILY_SHARING_NOT_ALLOWED',
    });
  });

  it('#11 webhook arrives before the app claims → record stored with userId=null; first claim by a matching user takes it (created)', async () => {
    const { guard, store } = makeGuard({
      routes: Object.fromEntries([
        productRoute('consumable'),
        [`POST ${consumeUrl('coins_100', 'gp-prod-token-coins')}`, ok()],
      ]),
    });
    const webhook = await guard.handleAppleNotification(appleJws.notifications.subscribed.body);
    expect(webhook.userId).toBeNull();
    const claim = await guard.claim(apple('subscriptionActive', 'user-1'));
    expect(claim).toMatchObject({ ownership: 'created', isNew: true, isEntitled: true });
    // The webhook's state (signed later, with renewal info) is kept.
    expect(claim.purchase.willRenew).toBe(true);

    // Google consumable: RTDN first, then the claim still grants exactly once.
    await guard.handleGoogleNotification(
      pushRequest(googleRtdn.notifications.oneTimePurchased.body),
    );
    expect((await store.findByKey('google', 'gp-prod-token-coins'))?.userId).toBeNull();
    const coins: ClaimInput = {
      userId: 'user-1',
      platform: 'google',
      type: 'one_time',
      purchaseToken: 'gp-prod-token-coins',
    };
    expect(await guard.claim(coins)).toMatchObject({ ownership: 'created', isNew: true });
    expect(await guard.claim(coins)).toMatchObject({ ownership: 'existing', isNew: false });
  });

  it('#12 user subscribes on both platforms → both recorded; otherActive on the second claim warns about double billing', async () => {
    const { guard } = makeGuard({
      routes: Object.fromEntries([
        subscriptionRoute('active'),
        [`POST ${ackSubscriptionUrl('premium_monthly', 'gp-sub-token-1')}`, ok()],
      ]),
    });
    const first = await guard.claim(apple('subscriptionActive', 'user-1'));
    expect(first.otherActive).toEqual([]);
    const second = await guard.claim(googleSub('gp-sub-token-1', 'user-1'));
    expect(second.otherActive.map((p) => [p.platform, p.key])).toEqual([
      ['apple', '2000000000000001'],
    ]);
    expect(await guard.entitlements('user-1')).toHaveLength(2);
  });

  it('#13 pending purchase (Google "slow card", Ask to Buy) → recorded, status=pending, not entitled, not acknowledged; a later notification activates it', async () => {
    const pendingToken = 'gp-sub-token-pending';
    const { guard, fetch } = makeGuard({
      routes: {
        ...Object.fromEntries([subscriptionRoute('pending')]),
        [`POST ${ackSubscriptionUrl('premium_monthly', pendingToken)}`]: ok(),
      },
    });
    const claim = await guard.claim(googleSub(pendingToken, 'user-1'));
    expect(claim).toMatchObject({ isEntitled: false, ownership: 'created' });
    expect(claim.purchase).toMatchObject({ status: 'pending', acknowledged: false });
    expect(fetch.callsTo(':acknowledge')).toHaveLength(0);

    // Payment clears: Play sends SUBSCRIPTION_PURCHASED and now reports the token active.
    fetch.route(...subscriptionRoute('active', pendingToken));
    const activated = await guard.handleGoogleNotification(
      pushRequest(
        pushBody(
          {
            version: '1.0',
            packageName: 'com.example.app',
            eventTimeMillis: String(NOW.getTime()),
            subscriptionNotification: {
              version: '1.0',
              notificationType: 4,
              purchaseToken: pendingToken,
            },
          },
          'pending-activated',
        ),
      ),
    );
    expect(activated).toMatchObject({ event: 'purchased', userId: 'user-1' });
    expect(activated.purchase).toMatchObject({ status: 'active', acknowledged: true });
    expect(fetch.callsTo(':acknowledge')).toHaveLength(1);
    expect(await guard.entitlements('user-1')).toHaveLength(1);
  });

  it('#14 refund / revoke → notification sets revoked; entitlement ends; event lets the app claw back consumables', async () => {
    const { guard } = makeGuard({
      routes: Object.fromEntries([subscriptionRoute('activeAcknowledged')]),
    });
    const consumable = await guard.claim(apple('consumable', 'user-1'));
    expect(consumable.isEntitled).toBe(true);
    const refund = await guard.handleAppleNotification(appleJws.notifications.refund.body);
    expect(refund).toMatchObject({ event: 'refunded', userId: 'user-1' });
    expect(refund.purchase).toMatchObject({
      status: 'revoked',
      key: '2000000000000300',
      quantity: 2,
    });
    expect(guard.isEntitled(refund.purchase!)).toBe(false);

    await guard.claim(googleSub('gp-sub-token-1', 'user-1'));
    const revoked = await guard.handleGoogleNotification(
      pushRequest(googleRtdn.notifications.subscriptionRevoked.body),
    );
    expect(revoked.purchase).toMatchObject({ status: 'revoked', revokedAt: NOW });
    expect(await guard.entitlements('user-1')).toEqual([]);
  });

  it('#15 account deleted → releaseUser(userId) frees the records so the store account can be restored into a new app account', async () => {
    const { guard, store } = makeGuard();
    await guard.claim(apple('subscriptionNoToken', 'user-1'));
    await guard.claim(apple('nonConsumable', 'user-1'));
    await guard.claim(apple('consumable', 'user-1'));

    expect(await guard.releaseUser('user-1')).toBe(3);
    expect(await guard.releaseUser('user-1')).toBe(0);
    expect((await store.findByKey('apple', '2000000000000100'))?.userId).toBeNull();

    const restored = await guard.claim(apple('subscriptionNoToken', 'new-account'));
    expect(restored).toMatchObject({
      ownership: 'created',
      isEntitled: true,
      previousUserId: null,
    });
    // claimedAt survives the release: the consumable can move, but is never granted twice.
    const coins = await guard.claim(apple('consumable', 'new-account'));
    expect(coins).toMatchObject({ ownership: 'created', isNew: false });
    expect((await store.findByKey('apple', '2000000000000300'))?.claimedAt).toEqual(NOW);
  });

  it('#16 sandbox purchase on a production server (App Review) → allowed by default, environment="sandbox"', async () => {
    const { guard } = makeGuard({
      routes: Object.fromEntries([subscriptionRoute('testPurchase')]),
    });
    const appleResult = await guard.claim(apple('sandbox', 'reviewer'));
    expect(appleResult).toMatchObject({ isEntitled: true });
    expect(appleResult.purchase.environment).toBe('sandbox');
    const googleResult = await guard.claim(googleSub('gp-sub-token-test', 'reviewer'));
    expect(googleResult.purchase.environment).toBe('sandbox');
  });

  it('#17 purchase for another app (bundle/package) → WRONG_APP', async () => {
    const { guard, store } = makeGuard();
    await expect(guard.claim(apple('wrongBundle', 'user-1'))).rejects.toMatchObject({
      code: 'WRONG_APP',
    });
    await expect(
      guard.handleAppleNotification(appleJws.notifications.innerWrongBundle.body),
    ).rejects.toMatchObject({ code: 'WRONG_APP' });
    await expect(
      guard.handleGoogleNotification(pushRequest(googleRtdn.notifications.wrongPackage.body)),
    ).rejects.toMatchObject({ code: 'WRONG_APP' });
    expect(store.size).toBe(0);
  });

  it('#18 forged / tampered / self-signed JWS, Xcode / StoreKit-testing transaction → INVALID_SIGNATURE', async () => {
    const { guard, store } = makeGuard();
    const proofs = [...Object.values(appleJws.invalidSignatures), tx.xcode.jws] as string[];
    for (const signedTransaction of proofs) {
      await expect(
        guard.claim({ userId: 'attacker', platform: 'apple', signedTransaction }),
      ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    }
    expect(store.size).toBe(0);
  });
});
