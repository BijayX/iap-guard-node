import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  IapGuard,
  MemoryPurchaseStore,
  VerificationError,
} from '../../src/index.js';
import { appleJws, fixedClock, makeGuard, plain, rootPem } from '../helpers/fixtures.js';

const notifications = Object.entries<any>(appleJws.notifications);

describe('App Store Server Notifications V2 (fixtures/apple/jws.json)', () => {
  describe.each(notifications.filter(([, n]) => n.expected))('%s', (_name, fixture) => {
    it('maps event, rawType, id and purchase', async () => {
      const { guard, store } = makeGuard();
      const result = await guard.handleAppleNotification(fixture.body);
      expect(result).toMatchObject({
        platform: 'apple',
        id: fixture.expected.id,
        event: fixture.expected.event,
        rawType: fixture.expected.rawType,
        duplicate: false,
        stale: false,
        userId: null,
      });
      expect(plain(result.purchase)).toEqual(fixture.expected.purchase);
      expect(result.raw).toMatchObject({ notificationUUID: fixture.expected.id });
      expect(store.size).toBe(fixture.expected.purchase ? 1 : 0);
    });
  });

  describe.each(notifications.filter(([, n]) => n.expectedError))('%s', (_name, fixture) => {
    it(`fails with ${fixture.expectedError}`, async () => {
      const { guard, store } = makeGuard();
      const error = await guard.handleAppleNotification(fixture.body).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(VerificationError);
      expect(error).toMatchObject({ code: fixture.expectedError });
      expect(store.size).toBe(0);
    });
  });

  it('accepts the raw JSON body as a string or Buffer', async () => {
    const { guard } = makeGuard();
    const raw = JSON.stringify(appleJws.notifications.test.body);
    await expect(guard.handleAppleNotification(raw)).resolves.toMatchObject({ event: 'test' });
    const { guard: other } = makeGuard();
    await expect(other.handleAppleNotification(Buffer.from(raw))).resolves.toMatchObject({
      event: 'test',
    });
  });

  it('rejects a body that is not JSON', async () => {
    const { guard } = makeGuard();
    await expect(guard.handleAppleNotification('{not json')).rejects.toMatchObject({
      code: 'INVALID_NOTIFICATION',
    });
  });

  it('dedupes by notificationUUID', async () => {
    const { guard } = makeGuard();
    const body = appleJws.notifications.didRenew.body;
    const first = await guard.handleAppleNotification(body);
    const second = await guard.handleAppleNotification(body);
    expect(first.duplicate).toBe(false);
    expect(second).toMatchObject({
      duplicate: true,
      purchase: null,
      userId: null,
      event: 'renewed',
    });
  });

  it('forgets the notification when processing throws, so the retry is processed', async () => {
    const store = new MemoryPurchaseStore();
    let fail = true;
    const flaky = Object.assign(Object.create(store) as MemoryPurchaseStore, {
      findByKey: (platform: 'apple' | 'google', key: string) =>
        fail ? Promise.reject(new Error('database is down')) : store.findByKey(platform, key),
    });
    const { guard } = makeGuard({ storeOverride: flaky });
    const body = appleJws.notifications.subscribed.body;

    await expect(guard.handleAppleNotification(body)).rejects.toThrow('database is down');
    fail = false;
    const retry = await guard.handleAppleNotification(body);
    expect(retry.duplicate).toBe(false);
    expect(retry.purchase?.status).toBe('active');
  });

  it('still rethrows the original error when forgetNotification fails', async () => {
    const store = new MemoryPurchaseStore();
    const broken = Object.assign(Object.create(store) as MemoryPurchaseStore, {
      findByKey: () => Promise.reject(new Error('database is down')),
      forgetNotification: () => Promise.reject(new Error('also down')),
    });
    const { guard, logs } = makeGuard({ storeOverride: broken });
    await expect(
      guard.handleAppleNotification(appleJws.notifications.subscribed.body),
    ).rejects.toThrow('database is down');
    expect(logs.some((log) => log.message.includes('could not forget'))).toBe(true);
  });

  it('keeps newer stored state when a stale notification arrives (stale = true)', async () => {
    const { guard } = makeGuard();
    await guard.claim({
      userId: 'user-1',
      platform: 'apple',
      signedTransaction: appleJws.transactions.subscriptionActive.jws,
    });
    const result = await guard.handleAppleNotification(appleJws.notifications.staleRenewal.body);
    expect(result).toMatchObject({ stale: true, userId: 'user-1', event: 'renewed' });
    expect(result.purchase?.transactionId).toBe('2000000000000002');
    expect(result.purchase?.status).toBe('active');
  });

  it('updates state without changing the owner', async () => {
    const { guard } = makeGuard();
    await guard.claim({
      userId: 'user-1',
      platform: 'apple',
      signedTransaction: appleJws.transactions.subscriptionActive.jws,
    });
    const result = await guard.handleAppleNotification(appleJws.notifications.gracePeriod.body);
    expect(result).toMatchObject({ userId: 'user-1', stale: false });
    expect(result.purchase?.status).toBe('grace_period');
    expect(await guard.entitlements('user-1')).toHaveLength(1);

    const expired = await guard.handleAppleNotification(appleJws.notifications.expired.body);
    expect(expired.purchase?.status).toBe('expired');
    expect(await guard.entitlements('user-1')).toHaveLength(0);
  });

  it('requires appAppleId when production is allowed', async () => {
    const guard = new IapGuard({
      apple: { bundleId: 'com.example.app', rootCertificates: [rootPem] },
      store: new MemoryPurchaseStore(),
      clock: fixedClock,
    });
    await expect(
      guard.handleAppleNotification(appleJws.notifications.test.body),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('does not require appAppleId for a sandbox-only server', async () => {
    const guard = new IapGuard({
      apple: {
        bundleId: 'com.example.app',
        rootCertificates: [rootPem],
        environments: ['sandbox'],
      },
      store: new MemoryPurchaseStore(),
      clock: fixedClock,
    });
    const result = await guard.handleAppleNotification(
      appleJws.notifications.sandboxSubscribed.body,
    );
    expect(result.purchase?.environment).toBe('sandbox');
  });

  it('requires a store', async () => {
    const guard = new IapGuard({
      apple: { bundleId: 'com.example.app', appAppleId: 1234567890, rootCertificates: [rootPem] },
      clock: fixedClock,
    });
    await expect(
      guard.handleAppleNotification(appleJws.notifications.test.body),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('creates unowned records that a later claim takes over', async () => {
    const { guard, store } = makeGuard();
    await guard.handleAppleNotification(appleJws.notifications.subscribed.body);
    const record = (await store.findByKey('apple', '2000000000000001'))!;
    expect(record.userId).toBeNull();
    expect(record.version).toBe(1);
  });
});
