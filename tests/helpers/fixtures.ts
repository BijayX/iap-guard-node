import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IapGuard,
  MemoryPurchaseStore,
  serializePurchase,
  type IapGuardConfig,
  type Logger,
  type Purchase,
  type PurchaseStore,
} from '../../src/index.js';
import { fakeFetch, type FakeFetch, type Handler } from './fake-fetch.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function readFixture(path: string): string {
  return readFileSync(join(FIXTURES, path), 'utf8');
}

export const appleJws: any = JSON.parse(readFixture('apple/jws.json'));
export const appleApi: any = JSON.parse(readFixture('apple/api.json'));
export const googleApi: any = JSON.parse(readFixture('google/api.json'));
export const googleRtdn: any = JSON.parse(readFixture('google/rtdn.json'));
export const googleOidc: any = JSON.parse(readFixture('google/oidc.json'));
export const accountTokens: any = JSON.parse(readFixture('account-tokens.json'));
export const serviceAccount: any = JSON.parse(readFixture('google/service-account.json'));
export const rootPem = readFixture('apple/certs/root.pem');
export const appleApiKey = readFixture('apple/keys/api-private-key.p8');

/** SPEC §12: fixture "now". */
export const NOW = new Date('2026-11-18T12:00:00Z');
export const fixedClock = () => new Date(NOW);

/** Purchase as fixture JSON: ISO dates, no `raw`. */
export function plain(purchase: Purchase | null): Record<string, unknown> | null {
  if (purchase === null) return null;
  const { raw: _raw, ...rest } = serializePurchase(purchase);
  return rest;
}

export const GOOGLE_BASE = googleApi.urls.base as string;
export const TOKEN_URL = googleApi.oauth.tokenUrl as string;
export const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const ACCOUNT_SECRET = accountTokens.secret as string;

export const googleUrl = (template: string, values: Record<string, string>): string =>
  GOOGLE_BASE +
  template.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(values[name]!));

export const subscriptionUrl = (token: string) => googleUrl(googleApi.urls.subscription, { token });
export const productUrl = (token: string) => googleUrl(googleApi.urls.product, { token });
export const ackSubscriptionUrl = (productId: string, token: string) =>
  googleUrl(googleApi.urls.acknowledgeSubscription, { productId, token });
export const ackProductUrl = (productId: string, token: string) =>
  googleUrl(googleApi.urls.acknowledgeProduct, { productId, token });
export const consumeUrl = (productId: string, token: string) =>
  googleUrl(googleApi.urls.consumeProduct, { productId, token });

/** `GET subscriptionsv2` route for a named fixture (optionally served for another token). */
export function subscriptionRoute(name: string, token?: string): [string, Handler] {
  const fixture = googleApi.subscriptions[name];
  return [`GET ${subscriptionUrl(token ?? fixture.token)}`, { status: 200, body: fixture.body }];
}

export function productRoute(name: string, token?: string): [string, Handler] {
  const fixture = googleApi.products[name];
  return [`GET ${productUrl(token ?? fixture.token)}`, { status: 200, body: fixture.body }];
}

export const baseRoutes = (): Record<string, Handler> => ({
  [`POST ${TOKEN_URL}`]: { status: 200, body: googleApi.oauth.tokenResponse },
  [`GET ${JWKS_URL}`]: {
    status: 200,
    body: googleOidc.jwks,
    headers: { 'Cache-Control': 'public, max-age=3600' },
  },
});

export interface TestGuard {
  guard: IapGuard;
  store: MemoryPurchaseStore;
  fetch: FakeFetch;
  logs: { level: string; message: string; context?: Record<string, unknown> }[];
}

export function recordingLogger(logs: TestGuard['logs']): Logger {
  return {
    debug: (message, context) =>
      logs.push({ level: 'debug', message, ...(context ? { context } : {}) }),
    warn: (message, context) =>
      logs.push({ level: 'warn', message, ...(context ? { context } : {}) }),
  };
}

export interface MakeGuardOptions extends Partial<IapGuardConfig> {
  routes?: Record<string, Handler>;
  appleApi?: boolean;
  storeOverride?: PurchaseStore;
}

/** IapGuard wired to the fixtures: both platforms, memory store, fake fetch, fixed clock. */
export function makeGuard(options: MakeGuardOptions = {}): TestGuard {
  const { routes, appleApi: withAppleApi, storeOverride, http, ...overrides } = options;
  const fetch = fakeFetch({ ...baseRoutes(), ...routes });
  const store = new MemoryPurchaseStore();
  const logs: TestGuard['logs'] = [];
  const guard = new IapGuard({
    apple: {
      bundleId: 'com.example.app',
      appAppleId: 1234567890,
      rootCertificates: [rootPem],
      ...(withAppleApi
        ? {
            api: {
              issuerId: appleApi.credentials.issuerId,
              keyId: appleApi.credentials.keyId,
              privateKey: appleApiKey,
            },
          }
        : {}),
    },
    google: {
      packageName: 'com.example.app',
      serviceAccount,
      consumableProductIds: ['coins_100'],
      pubsub: {
        audience: googleOidc.audience,
        serviceAccountEmail: googleOidc.serviceAccountEmail,
      },
    },
    store: storeOverride ?? store,
    clock: fixedClock,
    // The fake fetch is always used: tests must never reach the network.
    http: { retries: 0, retryDelayMs: 0, ...http, fetch },
    logger: recordingLogger(logs),
    ...overrides,
  });
  return { guard, store, fetch, logs };
}

/** Pub/Sub push request with a valid OIDC token. */
export function pushRequest(body: unknown, token: string = googleOidc.tokens.valid) {
  return { body, headers: { authorization: `Bearer ${token}` } };
}

/** Builds a push body for an arbitrary developer notification (same shape as rtdn.json). */
export function pushBody(notification: Record<string, unknown>, messageId: string) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(notification)).toString('base64'),
      messageId,
      publishTime: NOW.toISOString(),
    },
    subscription: 'projects/iap-guard-test/subscriptions/play-rtdn-push',
  };
}
