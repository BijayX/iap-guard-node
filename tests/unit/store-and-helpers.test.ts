import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  ConfigurationError,
  ErrorCode,
  IapError,
  MemoryPurchaseStore,
  NetworkError,
  OwnershipError,
  PolicyError,
  PurchaseNotFoundError,
  StoreApiError,
  ValidationError,
  VerificationError,
  deriveAccountToken,
  deserializePurchase,
  isEntitled,
  isIapError,
  serializePurchase,
  toWebhookResponse,
  webhookResponse,
  type NotificationResult,
  type Purchase,
  type PurchaseRecord,
} from '../../src/index.js';
import { accountTokensMatch } from '../../src/core/account-token.js';
import { createPurchase } from '../../src/core/purchase.js';
import { NOW, accountTokens, appleJws, makeGuard } from '../helpers/fixtures.js';

async function samplePurchase(name = 'subscriptionActive'): Promise<Purchase> {
  const { guard } = makeGuard();
  return guard.verify({ platform: 'apple', signedTransaction: appleJws.transactions[name].jws });
}

function record(purchase: Purchase, overrides: Partial<PurchaseRecord> = {}): PurchaseRecord {
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
    ...overrides,
  };
}

describe('account tokens (fixtures/account-tokens.json)', () => {
  const cases = accountTokens.cases as { userId: string; token: string }[];
  it.each(cases.map((c) => [c.userId.slice(0, 20), c.userId, c.token] as const))(
    '%s',
    (_label, userId, token) => {
      expect(deriveAccountToken(accountTokens.secret, userId)).toBe(token);
      expect(token).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    },
  );

  it('compares case-insensitively (StoreKit upper-cases UUIDs)', () => {
    const token = accountTokens.cases[0].token as string;
    expect(accountTokensMatch(token.toUpperCase(), token)).toBe(true);
    expect(accountTokensMatch(token, accountTokens.cases[1].token)).toBe(false);
  });
});

describe('isEntitled (SPEC §3)', () => {
  const at = (iso: string | null) => (iso === null ? null : new Date(iso));
  const p = (status: Purchase['status'], expiresAt: string | null, grace: string | null = null) =>
    ({ status, expiresAt: at(expiresAt), gracePeriodExpiresAt: at(grace) }) as Purchase;
  it.each([
    ['active, no expiry', p('active', null), true],
    ['active, future expiry', p('active', '2026-11-19T00:00:00Z'), true],
    ['active, expired', p('active', '2026-11-18T12:00:00Z'), false],
    [
      'grace, grace end in future',
      p('grace_period', '2026-11-17T00:00:00Z', '2026-11-20T00:00:00Z'),
      true,
    ],
    [
      'grace, grace end passed',
      p('grace_period', '2026-11-20T00:00:00Z', '2026-11-17T00:00:00Z'),
      false,
    ],
    ['grace, falls back to expiresAt', p('grace_period', '2026-11-20T00:00:00Z'), true],
    ['grace, no dates', p('grace_period', null), true],
    ['billing_retry', p('billing_retry', '2026-12-01T00:00:00Z'), false],
    ['pending', p('pending', null), false],
    ['revoked', p('revoked', null), false],
    ['paused', p('paused', null), false],
  ])('%s', (_name, purchase, expected) => {
    expect(isEntitled(purchase, NOW)).toBe(expected);
  });
});

describe('serializePurchase / deserializePurchase', () => {
  it('round-trips through JSON', async () => {
    const purchase = await samplePurchase('revoked');
    const revived = deserializePurchase(JSON.parse(JSON.stringify(serializePurchase(purchase))));
    expect(revived).toEqual(purchase);
    expect(Object.isFrozen(revived)).toBe(true);
  });

  it('tolerates missing dates', () => {
    const revived = deserializePurchase({ productIds: [], purchasedAt: undefined, signedAt: null });
    expect(revived.purchasedAt.getTime()).toBe(0);
    expect(revived.signedAt.getTime()).toBe(0);
  });
});

describe('MemoryPurchaseStore', () => {
  it('insert is unique per (platform, key) and per token', async () => {
    const store = new MemoryPurchaseStore();
    const purchase = await samplePurchase();
    expect(await store.insert(record(purchase, { tokens: ['t1'] }))).toBe(true);
    expect(await store.insert(record(purchase))).toBe(false);
    expect(await store.insert(record(purchase, { key: 'other', tokens: ['t1'] }))).toBe(false);
    expect(await store.insert(record(purchase, { platform: 'google', tokens: ['t1'] }))).toBe(true);
    expect(store.size).toBe(2);
  });

  it('replace is versioned and keeps token uniqueness', async () => {
    const store = new MemoryPurchaseStore();
    const purchase = await samplePurchase();
    await store.insert(record(purchase, { tokens: ['a'] }));
    await store.insert(record(purchase, { key: 'k2', tokens: ['b'] }));
    expect(await store.replace(record(purchase, { version: 2 }), 2)).toBe(false);
    expect(await store.replace(record(purchase, { key: 'missing', version: 2 }), 1)).toBe(false);
    expect(await store.replace(record(purchase, { version: 2, tokens: ['a', 'b'] }), 1)).toBe(
      false,
    );
    expect(await store.replace(record(purchase, { version: 2, tokens: ['a', 'c'] }), 1)).toBe(true);
    expect((await store.findByToken('apple', 'c'))?.version).toBe(2);
    expect(await store.findByToken('apple', 'zzz')).toBeNull();
  });

  it('returns copies that cannot mutate stored state', async () => {
    const store = new MemoryPurchaseStore();
    const purchase = await samplePurchase();
    await store.insert(record(purchase, { tokens: ['a'] }));
    const copy = (await store.findByKey('apple', purchase.key))!;
    (copy.tokens as string[]).push('b');
    expect((await store.findByKey('apple', purchase.key))!.tokens).toEqual(['a']);
    expect(await store.findByUser('u')).toHaveLength(1);
    expect(await store.findByUser('nobody')).toEqual([]);
  });

  it('remembers and forgets notifications per platform', async () => {
    const store = new MemoryPurchaseStore();
    expect(await store.rememberNotification('apple', 'n1')).toBe(true);
    expect(await store.rememberNotification('apple', 'n1')).toBe(false);
    expect(await store.rememberNotification('google', 'n1')).toBe(true);
    await store.forgetNotification('apple', 'n1');
    expect(await store.rememberNotification('apple', 'n1')).toBe(true);
    store.clear();
    expect(await store.rememberNotification('google', 'n1')).toBe(true);
    expect(store.size).toBe(0);
  });
});

describe('errors', () => {
  it('carry stable codes and serialize without secrets', () => {
    const error = new StoreApiError('boom', {
      platform: 'google',
      statusCode: 503,
      responseBody: { x: 1 },
    });
    expect(error).toMatchObject({
      code: ErrorCode.STORE_API_ERROR,
      retryable: true,
      name: 'StoreApiError',
    });
    expect(error.toJSON()).toEqual({
      name: 'StoreApiError',
      code: 'STORE_API_ERROR',
      message: 'boom',
      platform: 'google',
      details: { statusCode: 503 },
    });
    expect(new StoreApiError('x').retryable).toBe(true);
    expect(new StoreApiError('x', { statusCode: 404 }).retryable).toBe(false);
    expect(new StoreApiError('x', { statusCode: 429 }).retryable).toBe(true);
  });

  it.each([
    [new ConfigurationError('x'), 'CONFIGURATION_ERROR'],
    [new ValidationError('x'), 'VALIDATION_ERROR'],
    [new AuthenticationError('x'), 'AUTHENTICATION_FAILED'],
    [new NetworkError('x'), 'NETWORK_ERROR'],
    [new NetworkError('x', { timeout: true }), 'TIMEOUT'],
    [new VerificationError('WRONG_APP', 'x'), 'WRONG_APP'],
    [new PolicyError('UNKNOWN_PRODUCT', 'x'), 'UNKNOWN_PRODUCT'],
    [new PurchaseNotFoundError('x'), 'PURCHASE_NOT_FOUND'],
    [new OwnershipError('ALREADY_OWNED', 'x'), 'ALREADY_OWNED'],
    [
      new IapError('CONCURRENT_MODIFICATION', 'x', { cause: new Error('c') }),
      'CONCURRENT_MODIFICATION',
    ],
  ])('%o has code %s', (error, code) => {
    expect(error.code).toBe(code);
    expect(isIapError(error)).toBe(true);
    expect(error).toBeInstanceOf(IapError);
  });

  it('ValidationError.fromFields', () => {
    expect(ValidationError.fromFields({}).message).toBe('Invalid input: is invalid');
    expect(ValidationError.fromFields({ a: [] }).message).toBe('Invalid a: is invalid');
    expect(isIapError(new Error('x'))).toBe(false);
  });
});

describe('toWebhookResponse (SPEC §8)', () => {
  const result = {
    platform: 'apple',
    id: 'n',
    event: 'test',
    duplicate: false,
    stale: false,
  } as NotificationResult;
  it.each([
    ['a result', result, 200],
    ['a duplicate', { ...result, duplicate: true }, 200],
    ['VerificationError', new VerificationError('INVALID_SIGNATURE', 'x'), 400],
    ['ValidationError', new ValidationError('x'), 400],
    ['PolicyError', new PolicyError('ENVIRONMENT_NOT_ALLOWED', 'x'), 400],
    ['StoreApiError', new StoreApiError('x'), 500],
    ['NetworkError', new NetworkError('x'), 500],
    ['AuthenticationError (our credentials)', new AuthenticationError('x'), 500],
    ['ConfigurationError', new ConfigurationError('x'), 500],
    ['a foreign error', new Error('db'), 500],
    ['a non-error', 'weird', 500],
  ])('%s → %i', (_name, outcome, status) => {
    expect(toWebhookResponse(outcome).status).toBe(status);
  });

  it('bodies carry codes only', () => {
    expect(toWebhookResponse(new Error('secret db password')).body).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    });
    expect(toWebhookResponse(new VerificationError('INVALID_SIGNATURE', 'details')).body).toEqual({
      ok: false,
      error: 'INVALID_SIGNATURE',
    });
  });

  it('webhookResponse runs a handler and never throws', async () => {
    await expect(webhookResponse(() => Promise.resolve(result))).resolves.toMatchObject({
      status: 200,
    });
    await expect(
      webhookResponse(() => Promise.reject(new StoreApiError('x'))),
    ).resolves.toMatchObject({
      status: 500,
      body: { error: 'STORE_API_ERROR' },
    });
  });
});

it('createPurchase freezes productIds', async () => {
  const purchase = createPurchase({ ...(await samplePurchase()), productIds: ['a'] });
  expect(Object.isFrozen(purchase.productIds)).toBe(true);
});

it('VERSION matches package.json (User-Agent)', async () => {
  const { VERSION } = await import('../../src/core/version.js');
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  expect(VERSION).toBe(pkg.version);
});
