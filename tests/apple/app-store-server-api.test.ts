import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthenticationError, PurchaseNotFoundError, StoreApiError } from '../../src/index.js';
import type { Reply } from '../helpers/fake-fetch.js';
import {
  NOW,
  appleApi,
  appleApiKey,
  appleJws,
  makeGuard,
  plain,
  rootPem,
} from '../helpers/fixtures.js';

const PROD = appleApi.baseUrls.production as string;
const SANDBOX = appleApi.baseUrls.sandbox as string;
const R = appleApi.responses;
const reply = (name: string): Reply => ({
  status: R[name].status,
  body: R[name].body,
  ...(R[name].headers ? { headers: R[name].headers } : {}),
});

function decodeSegment(segment: string): any {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('App Store Server API', () => {
  it('signs a JWT whose header and claims match apple/api.json', async () => {
    const { guard, fetch } = makeGuard({
      appleApi: true,
      routes: { [`GET ${PROD}${R.transactionInfo.path}`]: reply('transactionInfo') },
    });
    await guard.verify({ platform: 'apple', transactionId: '2000000000000200' });

    const authorization = fetch.calls[0]!.headers.Authorization!;
    expect(authorization).toMatch(/^Bearer /);
    const jwt = authorization.slice('Bearer '.length);
    const [h, p, s] = jwt.split('.') as [string, string, string];

    // Verify with the public key derived from the .p8 file.
    const publicKey = createPublicKey(appleApiKey);
    const signature = Buffer.from(s, 'base64url');
    expect(signature).toHaveLength(64); // raw r||s, not DER
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        signature,
      ),
    ).toBe(true);

    const expected = appleApi.expectedJwt;
    expect(decodeSegment(h)).toEqual(expected.header);
    const claims = decodeSegment(p);
    expect(claims).toMatchObject({
      iss: expected.claims.iss,
      aud: expected.claims.aud,
      bid: expected.claims.bid,
    });
    expect(claims.iat).toBe(NOW.getTime() / 1000);
    expect(claims.exp - claims.iat).toBe(expected.claims.expMinusIat);
    expect(fetch.calls[0]!.headers['User-Agent']).toBe('iap-guard-node/0.1.0');
  });

  it('reuses the JWT within its lifetime and regenerates it before expiry', async () => {
    let now = NOW.getTime();
    const { guard, fetch } = makeGuard({
      appleApi: true,
      clock: () => new Date(now),
      routes: { [`GET ${PROD}${R.transactionInfo.path}`]: reply('transactionInfo') },
    });
    const verifyOnce = () => guard.verify({ platform: 'apple', transactionId: '2000000000000200' });
    await verifyOnce();
    now += 60_000;
    await verifyOnce();
    now += 4 * 60_000; // 5 minutes after the first token: past the refresh point
    await verifyOnce();
    const tokens = fetch.calls.map((call) => call.headers.Authorization);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[1]);
  });

  it('verify({ transactionId }) verifies the returned signedTransactionInfo', async () => {
    const { guard } = makeGuard({
      appleApi: true,
      routes: { [`GET ${PROD}${R.transactionInfo.path}`]: reply('transactionInfo') },
    });
    const purchase = await guard.verify({ platform: 'apple', transactionId: '2000000000000200' });
    expect(plain(purchase)).toEqual(appleJws.transactions.nonConsumable.expected);
  });

  it('falls back from production to sandbox on 4040010', async () => {
    const { guard, fetch } = makeGuard({
      appleApi: true,
      routes: {
        [`GET ${PROD}${R.transactionInfo.path}`]: reply('transactionNotFound'),
        [`GET ${SANDBOX}${R.transactionInfo.path}`]: reply('transactionInfo'),
      },
    });
    const purchase = await guard.verify({ platform: 'apple', transactionId: '2000000000000200' });
    expect(purchase.productId).toBe('lifetime_unlock');
    expect(fetch.calls.map((call) => call.url)).toEqual([
      `${PROD}${R.transactionInfo.path}`,
      `${SANDBOX}${R.transactionInfo.path}`,
    ]);
  });

  it('throws PurchaseNotFoundError when neither environment knows the transaction', async () => {
    const { guard } = makeGuard({
      appleApi: true,
      routes: {
        [`GET ${PROD}${R.transactionInfo.path}`]: reply('transactionNotFound'),
        [`GET ${SANDBOX}${R.transactionInfo.path}`]: reply('transactionNotFound'),
      },
    });
    await expect(
      guard.verify({ platform: 'apple', transactionId: '2000000000000200' }),
    ).rejects.toBeInstanceOf(PurchaseNotFoundError);
  });

  it('only calls allowed environments', async () => {
    const { guard, fetch } = makeGuard({
      appleApi: false,
      apple: {
        bundleId: 'com.example.app',
        rootCertificates: [rootPem],
        environments: ['sandbox'],
        api: {
          issuerId: appleApi.credentials.issuerId,
          keyId: appleApi.credentials.keyId,
          privateKey: appleApiKey,
          baseUrls: { sandbox: `${SANDBOX}/` },
        },
      },
      routes: { [`GET ${SANDBOX}${R.transactionInfo.path}`]: reply('transactionNotFound') },
    });
    await expect(
      guard.verify({ platform: 'apple', transactionId: '2000000000000200' }),
    ).rejects.toBeInstanceOf(PurchaseNotFoundError);
    expect(fetch.calls).toHaveLength(1);
  });

  it.each([['subscriptionStatusGrace'], ['subscriptionStatusActive']])(
    'auto-renewable: builds the latest state from %s',
    async (name) => {
      const { guard, fetch } = makeGuard({
        appleApi: true,
        routes: { [`GET ${PROD}${R[name].path}`]: reply(name) },
      });
      const purchase = await guard.verify({
        platform: 'apple',
        signedTransaction: appleJws.transactions.subscriptionActive.jws,
      });
      expect(plain(purchase)).toEqual(R[name].expected);
      expect(fetch.calls).toHaveLength(1);
    },
  );

  it('falls back to the client transaction when the status response lacks it', async () => {
    const body = { ...R.subscriptionStatusActive.body, data: [{ lastTransactions: [] }] };
    const { guard } = makeGuard({
      appleApi: true,
      routes: { [`GET ${PROD}${R.subscriptionStatusActive.path}`]: { status: 200, body } },
    });
    const purchase = await guard.verify({
      platform: 'apple',
      signedTransaction: appleJws.transactions.subscriptionActive.jws,
    });
    expect(plain(purchase)).toEqual(appleJws.transactions.subscriptionActive.expected);
  });

  it('falls back to the client transaction on 4040010 from the status endpoint', async () => {
    const { guard } = makeGuard({
      appleApi: true,
      routes: { [`GET ${PROD}${R.subscriptionStatusActive.path}`]: reply('transactionNotFound') },
    });
    const purchase = await guard.verify({
      platform: 'apple',
      signedTransaction: appleJws.transactions.subscriptionActive.jws,
    });
    expect(purchase.transactionId).toBe('2000000000000002');
  });

  it('does not call the API for non-subscriptions', async () => {
    const { guard, fetch } = makeGuard({ appleApi: true });
    await guard.verify({
      platform: 'apple',
      signedTransaction: appleJws.transactions.consumable.jws,
    });
    expect(fetch.calls).toHaveLength(0);
  });

  it('401 → AuthenticationError', async () => {
    const { guard } = makeGuard({
      appleApi: true,
      routes: { [`GET ${PROD}${R.transactionInfo.path}`]: reply('unauthorized') },
    });
    const error = await guard
      .verify({ platform: 'apple', transactionId: '2000000000000200' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(JSON.stringify(error)).not.toMatch(/Bearer|eyJ/);
  });

  it('429 → retryable StoreApiError; retried once after Retry-After', async () => {
    const { guard, fetch } = makeGuard({
      appleApi: true,
      http: { retries: 1, retryDelayMs: 0 },
      routes: {
        [`GET ${PROD}${R.transactionInfo.path}`]: [reply('rateLimited'), reply('rateLimited')],
      },
    });
    const started = Date.now();
    const error = await guard
      .verify({ platform: 'apple', transactionId: '2000000000000200' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreApiError);
    expect(error).toMatchObject({ statusCode: 429, retryable: true });
    expect(fetch.calls).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900); // Retry-After: 1
  });

  it('500 → retryable StoreApiError (retried, then succeeds)', async () => {
    const { guard, fetch } = makeGuard({
      appleApi: true,
      http: { retries: 2, retryDelayMs: 0 },
      routes: {
        [`GET ${PROD}${R.transactionInfo.path}`]: [reply('serverError'), reply('transactionInfo')],
      },
    });
    await expect(
      guard.verify({ platform: 'apple', transactionId: '2000000000000200' }),
    ).resolves.toMatchObject({ productId: 'lifetime_unlock' });
    expect(fetch.calls).toHaveLength(2);
  });

  it('500 after all retries → retryable StoreApiError with the error message', async () => {
    const { guard } = makeGuard({
      appleApi: true,
      routes: { [`GET ${PROD}${R.transactionInfo.path}`]: reply('serverError') },
    });
    await expect(
      guard.verify({ platform: 'apple', transactionId: '2000000000000200' }),
    ).rejects.toMatchObject({
      code: 'STORE_API_ERROR',
      statusCode: 500,
      retryable: true,
      message: expect.stringContaining('An unknown error occurred.'),
    });
  });

  it('other 4xx → non-retryable StoreApiError', async () => {
    const { guard } = makeGuard({
      appleApi: true,
      routes: {
        [`GET ${PROD}${R.transactionInfo.path}`]: {
          status: 400,
          body: { errorCode: 4000006, errorMessage: 'Invalid transaction id.' },
        },
      },
    });
    await expect(
      guard.verify({ platform: 'apple', transactionId: '2000000000000200' }),
    ).rejects.toMatchObject({ code: 'STORE_API_ERROR', statusCode: 400, retryable: false });
  });

  it.each([
    ['a non-object body', 'oops'],
    ['no signedTransactionInfo', { foo: 1 }],
  ])('200 with %s → StoreApiError', async (_name, body) => {
    const { guard } = makeGuard({
      appleApi: true,
      routes: { [`GET ${PROD}${R.transactionInfo.path}`]: { status: 200, body } },
    });
    await expect(
      guard.verify({ platform: 'apple', transactionId: '2000000000000200' }),
    ).rejects.toMatchObject({ code: 'STORE_API_ERROR', retryable: false });
  });

  it('verifies signed values from the API like client input', async () => {
    const forged = appleJws.invalidSignatures.rogueChain;
    const { guard } = makeGuard({
      appleApi: true,
      routes: {
        [`GET ${PROD}${R.transactionInfo.path}`]: {
          status: 200,
          body: { signedTransactionInfo: forged },
        },
      },
    });
    await expect(
      guard.verify({ platform: 'apple', transactionId: '2000000000000200' }),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });
});
