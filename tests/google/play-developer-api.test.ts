import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  IapGuard,
  PurchaseNotFoundError,
  StoreApiError,
  VerificationError,
} from '../../src/index.js';
import {
  NOW,
  TOKEN_URL,
  googleApi,
  makeGuard,
  plain,
  productRoute,
  productUrl,
  readFixture,
  serviceAccount,
  subscriptionRoute,
  subscriptionUrl,
} from '../helpers/fixtures.js';

const subscriptions = Object.entries<any>(googleApi.subscriptions);
const products = Object.entries<any>(googleApi.products);

describe('subscriptionsv2 normalization (fixtures/google/api.json)', () => {
  describe.each(subscriptions)('%s', (name, fixture) => {
    it('matches the expected Purchase', async () => {
      const { guard, fetch } = makeGuard({ routes: Object.fromEntries([subscriptionRoute(name)]) });
      const purchase = await guard.verify({
        platform: 'google',
        type: 'subscription',
        purchaseToken: fixture.token,
      });
      expect(plain(purchase)).toEqual(fixture.expected);
      expect(purchase.raw).toEqual(fixture.body);
      const apiCall = fetch.callsTo('subscriptionsv2')[0]!;
      expect(apiCall.url).toBe(
        googleApi.urls.base + googleApi.urls.subscription.replace('{token}', fixture.token),
      );
      expect(apiCall.headers.Authorization).toBe(
        `Bearer ${googleApi.oauth.tokenResponse.access_token}`,
      );
    });
  });
});

describe('productsv2 normalization (fixtures/google/api.json)', () => {
  describe.each(products)('%s', (name, fixture) => {
    it('matches the expected Purchase', async () => {
      const { guard } = makeGuard({ routes: Object.fromEntries([productRoute(name)]) });
      const purchase = await guard.verify({
        platform: 'google',
        type: 'one_time',
        purchaseToken: fixture.token,
      });
      expect(plain(purchase)).toEqual(fixture.expected);
    });
  });
});

describe('Google verify rules', () => {
  it('PRODUCT_MISMATCH when productId is not in the purchase', async () => {
    const { guard } = makeGuard({ routes: Object.fromEntries([subscriptionRoute('active')]) });
    const error = await guard
      .verify({
        platform: 'google',
        type: 'subscription',
        purchaseToken: 'gp-sub-token-1',
        productId: 'premium_yearly',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VerificationError);
    expect(error).toMatchObject({ code: 'PRODUCT_MISMATCH' });
  });

  it('accepts any productId of a bundle', async () => {
    const { guard } = makeGuard({ routes: Object.fromEntries([subscriptionRoute('bundle')]) });
    await expect(
      guard.verify({
        platform: 'google',
        type: 'subscription',
        purchaseToken: 'gp-sub-token-bundle',
        productId: 'addon_storage',
      }),
    ).resolves.toMatchObject({ productIds: ['premium_monthly', 'addon_storage'] });
  });

  it('ENVIRONMENT_NOT_ALLOWED for test purchases when allowTestPurchases is false', async () => {
    const routes = Object.fromEntries([
      subscriptionRoute('testPurchase'),
      productRoute('testPurchase'),
    ]);
    const { guard } = makeGuard({
      routes,
      google: {
        packageName: 'com.example.app',
        serviceAccount,
        allowTestPurchases: false,
      },
    });
    await expect(
      guard.verify({
        platform: 'google',
        type: 'subscription',
        purchaseToken: 'gp-sub-token-test',
      }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_ALLOWED' });
    await expect(
      guard.verify({ platform: 'google', type: 'one_time', purchaseToken: 'gp-prod-token-test' }),
    ).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_ALLOWED' });
  });

  it('UNKNOWN_PRODUCT when any line item is outside the allowlist', async () => {
    const { guard } = makeGuard({
      products: ['premium_monthly'],
      routes: Object.fromEntries([subscriptionRoute('bundle'), subscriptionRoute('active')]),
    });
    await expect(
      guard.verify({
        platform: 'google',
        type: 'subscription',
        purchaseToken: 'gp-sub-token-bundle',
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_PRODUCT' });
    await expect(
      guard.verify({ platform: 'google', type: 'subscription', purchaseToken: 'gp-sub-token-1' }),
    ).resolves.toMatchObject({ productId: 'premium_monthly' });
  });

  it('URL-encodes path segments', async () => {
    const token = 'tok/with?odd#chars';
    const { guard, fetch } = makeGuard({
      routes: Object.fromEntries([subscriptionRoute('active', token)]),
    });
    await guard.verify({ platform: 'google', type: 'subscription', purchaseToken: token });
    expect(fetch.callsTo('subscriptionsv2')[0]!.url).toContain('tokens/tok%2Fwith%3Fodd%23chars');
  });

  it('a response without line items is a StoreApiError', async () => {
    const { guard } = makeGuard({
      routes: {
        [`GET ${subscriptionUrl('x')}`]: {
          status: 200,
          body: { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE' },
        },
        [`GET ${productUrl('y')}`]: { status: 200, body: { productLineItem: [] } },
      },
    });
    await expect(
      guard.verify({ platform: 'google', type: 'subscription', purchaseToken: 'x' }),
    ).rejects.toBeInstanceOf(StoreApiError);
    await expect(
      guard.verify({ platform: 'google', type: 'one_time', purchaseToken: 'y' }),
    ).rejects.toBeInstanceOf(StoreApiError);
  });

  it('a non-JSON 200 body is a StoreApiError', async () => {
    const { guard } = makeGuard({
      routes: { [`GET ${subscriptionUrl('x')}`]: { status: 200, body: '<html>' } },
    });
    await expect(
      guard.verify({ platform: 'google', type: 'subscription', purchaseToken: 'x' }),
    ).rejects.toMatchObject({ code: 'STORE_API_ERROR', retryable: false });
  });
});

describe('Play Developer API errors (fixtures/google/api.json errors)', () => {
  const cases: [string, new (...args: never[]) => Error, Record<string, unknown>][] = [
    ['notFound', PurchaseNotFoundError, { code: 'PURCHASE_NOT_FOUND' }],
    ['gone', PurchaseNotFoundError, { code: 'PURCHASE_NOT_FOUND' }],
    ['invalidToken', PurchaseNotFoundError, { code: 'PURCHASE_NOT_FOUND' }],
    ['unauthorized', AuthenticationError, { code: 'AUTHENTICATION_FAILED' }],
    ['forbidden', AuthenticationError, { code: 'AUTHENTICATION_FAILED' }],
    ['rateLimited', StoreApiError, { statusCode: 429, retryable: true }],
    ['serverError', StoreApiError, { statusCode: 503, retryable: true }],
  ];
  it.each(cases)('%s', async (name, type, shape) => {
    const fixture = googleApi.errors[name];
    const { guard } = makeGuard({
      routes: {
        [`GET ${subscriptionUrl('gp-sub-token-1')}`]: {
          status: fixture.status,
          body: fixture.body,
        },
      },
    });
    const error = await guard
      .verify({ platform: 'google', type: 'subscription', purchaseToken: 'gp-sub-token-1' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject({ platform: 'google', ...shape });
    expect(JSON.stringify(error)).not.toContain('ya29');
  });

  it('other 4xx → non-retryable StoreApiError', async () => {
    const { guard } = makeGuard({
      routes: { [`GET ${subscriptionUrl('t')}`]: { status: 409, body: { error: { code: 409 } } } },
    });
    await expect(
      guard.verify({ platform: 'google', type: 'subscription', purchaseToken: 't' }),
    ).rejects.toMatchObject({ code: 'STORE_API_ERROR', retryable: false, statusCode: 409 });
  });

  it('retries 5xx GETs, then succeeds', async () => {
    const fixture = googleApi.subscriptions.active;
    const { guard, fetch } = makeGuard({
      http: { retries: 2, retryDelayMs: 0 },
      routes: {
        [`GET ${subscriptionUrl('gp-sub-token-1')}`]: [
          { status: 503, body: googleApi.errors.serverError.body },
          { status: 429, body: googleApi.errors.rateLimited.body },
          { status: 200, body: fixture.body },
        ],
      },
    });
    await expect(
      guard.verify({ platform: 'google', type: 'subscription', purchaseToken: 'gp-sub-token-1' }),
    ).resolves.toMatchObject({ status: 'active' });
    expect(fetch.callsTo('subscriptionsv2')).toHaveLength(3);
  });

  it('a 401 drops the cached access token', async () => {
    const fixture = googleApi.subscriptions.active;
    const { guard, fetch } = makeGuard({
      routes: {
        [`GET ${subscriptionUrl('gp-sub-token-1')}`]: [
          { status: 401, body: googleApi.errors.unauthorized.body },
          { status: 200, body: fixture.body },
        ],
      },
    });
    const input = {
      platform: 'google',
      type: 'subscription',
      purchaseToken: 'gp-sub-token-1',
    } as const;
    await expect(guard.verify(input)).rejects.toBeInstanceOf(AuthenticationError);
    await guard.verify(input);
    expect(fetch.callsTo(TOKEN_URL)).toHaveLength(2);
  });
});

describe('service-account OAuth', () => {
  it('posts a valid RS256 assertion with the SPEC §6.2 claims', async () => {
    const { guard, fetch } = makeGuard({
      routes: Object.fromEntries([subscriptionRoute('active')]),
    });
    await guard.verify({
      platform: 'google',
      type: 'subscription',
      purchaseToken: 'gp-sub-token-1',
    });

    const call = fetch.callsTo(TOKEN_URL)[0]!;
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(call.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, p, s] = form.get('assertion')!.split('.') as [string, string, string];
    const publicKey = createPublicKey(readFixture('google/service-account.public.pem'));
    expect(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'))).toBe(
      true,
    );
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const iat = NOW.getTime() / 1000;
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      iss: serviceAccount.client_email,
      scope: googleApi.oauth.scope,
      aud: googleApi.oauth.tokenUrl,
      iat,
      exp: iat + 3600,
    });
  });

  it('concurrent calls share one token request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const routes = Object.fromEntries([
      subscriptionRoute('active'),
      productRoute('consumable'),
      productRoute('nonConsumable'),
    ]);
    const { guard, fetch } = makeGuard({
      routes: {
        ...routes,
        [`POST ${TOKEN_URL}`]: async () => {
          await gate;
          return { status: 200, body: googleApi.oauth.tokenResponse };
        },
      },
    });
    const pending = Promise.all([
      guard.verify({ platform: 'google', type: 'subscription', purchaseToken: 'gp-sub-token-1' }),
      guard.verify({ platform: 'google', type: 'one_time', purchaseToken: 'gp-prod-token-coins' }),
      guard.verify({
        platform: 'google',
        type: 'one_time',
        purchaseToken: 'gp-prod-token-lifetime',
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await pending;
    expect(fetch.callsTo(TOKEN_URL)).toHaveLength(1);
  });

  it('caches the token until expires_in - 60 s', async () => {
    let now = NOW.getTime();
    const { guard, fetch } = makeGuard({
      clock: () => new Date(now),
      routes: Object.fromEntries([subscriptionRoute('active')]),
    });
    const input = {
      platform: 'google',
      type: 'subscription',
      purchaseToken: 'gp-sub-token-1',
    } as const;
    await guard.verify(input);
    now += (3599 - 61) * 1000;
    await guard.verify(input);
    expect(fetch.callsTo(TOKEN_URL)).toHaveLength(1);
    now += 2000;
    await guard.verify(input);
    expect(fetch.callsTo(TOKEN_URL)).toHaveLength(2);
  });

  it('token endpoint 400 → AuthenticationError without the assertion or key', async () => {
    const { guard } = makeGuard({
      routes: {
        [`POST ${TOKEN_URL}`]: { status: 400, body: googleApi.oauth.tokenError.body },
      },
    });
    const error = await guard
      .verify({ platform: 'google', type: 'subscription', purchaseToken: 'gp-sub-token-1' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toMatchObject({ details: { error: 'invalid_grant' } });
    const serialized = JSON.stringify(error) + (error as Error).message;
    expect(serialized).not.toContain('eyJ');
    expect(serialized).not.toContain('PRIVATE KEY');
  });

  it('a failed token request is not cached; the next call retries', async () => {
    const { guard, fetch } = makeGuard({
      routes: {
        ...Object.fromEntries([subscriptionRoute('active')]),
        [`POST ${TOKEN_URL}`]: [
          { status: 503, body: 'unavailable' },
          { status: 200, body: googleApi.oauth.tokenResponse },
        ],
      },
    });
    const input = {
      platform: 'google',
      type: 'subscription',
      purchaseToken: 'gp-sub-token-1',
    } as const;
    await expect(guard.verify(input)).rejects.toMatchObject({
      code: 'STORE_API_ERROR',
      statusCode: 503,
    });
    await expect(guard.verify(input)).resolves.toBeDefined();
    expect(fetch.callsTo(TOKEN_URL)).toHaveLength(2);
  });

  it('uses token_uri from the service account when tokenUrl is not set', async () => {
    const custom = { ...serviceAccount, token_uri: 'https://oauth.example.test/token' };
    const { guard, fetch } = makeGuard({
      google: { packageName: 'com.example.app', serviceAccount: JSON.stringify(custom) },
      routes: {
        ...Object.fromEntries([subscriptionRoute('active')]),
        'POST https://oauth.example.test/token': {
          status: 200,
          body: googleApi.oauth.tokenResponse,
        },
      },
    });
    await guard.verify({
      platform: 'google',
      type: 'subscription',
      purchaseToken: 'gp-sub-token-1',
    });
    expect(fetch.callsTo('oauth.example.test')).toHaveLength(1);
  });
});

describe('Google configuration', () => {
  it.each([
    [{ packageName: '', serviceAccount }, 'packageName'],
    [{ packageName: 'p', serviceAccount: '{nope' }, 'not valid JSON'],
    [{ packageName: 'p', serviceAccount: { client_email: 'x' } }, 'client_email and private_key'],
    [
      { packageName: 'p', serviceAccount: { client_email: 'x', private_key: 'bad' } },
      'not a valid PEM',
    ],
    [
      {
        packageName: 'p',
        serviceAccount: {
          client_email: 'x',
          private_key: readFixture('apple/keys/api-private-key.p8'),
        },
      },
      'must be an RSA key',
    ],
  ])('rejects %#', (google, fragment) => {
    let error: unknown;
    try {
      new IapGuard({ google });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: 'CONFIGURATION_ERROR' });
    expect((error as Error).message).toContain(fragment);
    expect(JSON.stringify(error) + (error as Error).message).not.toContain('PRIVATE KEY');
  });

  it('verify requires the platform to be configured', async () => {
    const guard = new IapGuard({ google: { packageName: 'p', serviceAccount } });
    await expect(
      guard.verify({ platform: 'apple', signedTransaction: 'x.y.z' }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', platform: 'apple' });
  });
});
