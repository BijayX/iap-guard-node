import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  IapGuard,
  MemoryPurchaseStore,
  StoreApiError,
  VerificationError,
} from '../../src/index.js';
import { fakeFetch } from '../helpers/fake-fetch.js';
import {
  JWKS_URL,
  NOW,
  fixedClock,
  googleOidc,
  googleRtdn,
  makeGuard,
  pushRequest,
  serviceAccount,
} from '../helpers/fixtures.js';

const testBody = googleRtdn.notifications.test.body;
const ACCEPTED = new Set(['valid', 'validShortIssuer']);
/** Each rejected token must fail for its own reason. */
const REASONS: Record<string, string> = {
  wrongAudience: 'wrong audience',
  expired: 'token expired',
  issuedInFuture: 'issued in the future',
  wrongIssuer: 'wrong issuer',
  wrongEmail: 'unexpected service account',
  emailNotVerified: 'unexpected service account',
  unknownKid: 'unknown signing key',
  signedByOtherKey: 'bad signature',
  tamperedClaims: 'bad signature',
  algNone: 'alg must be RS256',
  algHS256: 'alg must be RS256',
};

describe('Pub/Sub push OIDC tokens (fixtures/google/oidc.json)', () => {
  describe.each(Object.entries<string>(googleOidc.tokens))('%s', (name, token) => {
    if (ACCEPTED.has(name)) {
      it('is accepted', async () => {
        const { guard } = makeGuard();
        await expect(
          guard.handleGoogleNotification(pushRequest(testBody, token)),
        ).resolves.toMatchObject({
          event: 'test',
          rawType: 'TEST',
          purchase: null,
        });
      });
    } else {
      it('is rejected with INVALID_SIGNATURE', async () => {
        const { guard, store } = makeGuard();
        const error = await guard
          .handleGoogleNotification(pushRequest(testBody, token))
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(VerificationError);
        expect(error).toMatchObject({ code: 'INVALID_SIGNATURE', platform: 'google' });
        expect((error as Error).message).toContain(REASONS[name]);
        // Authentication happens before parsing and dedupe.
        expect(await store.rememberNotification('google', testBody.message.messageId)).toBe(true);
      });
    }
  });

  it('covers every token in the fixture', () => {
    expect([...ACCEPTED, ...Object.keys(REASONS)].sort()).toEqual(
      Object.keys(googleOidc.tokens).sort(),
    );
  });

  it.each([
    ['no Authorization header', {}],
    ['a Basic Authorization header', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['a malformed bearer token', { authorization: 'Bearer not-a-jwt' }],
    ['a token without kid', { authorization: `Bearer ${withoutKid()}` }],
  ])('rejects %s', async (_name, headers) => {
    const { guard } = makeGuard();
    await expect(guard.handleGoogleNotification({ body: testBody, headers })).rejects.toMatchObject(
      { code: 'INVALID_SIGNATURE' },
    );
  });

  it('reads the header case-insensitively, from Headers or arrays', async () => {
    const { guard } = makeGuard();
    const headers = new Headers({ Authorization: `Bearer ${googleOidc.tokens.valid}` });
    await expect(
      guard.handleGoogleNotification({ body: testBody, headers }),
    ).resolves.toBeDefined();
    const { guard: other } = makeGuard();
    await expect(
      other.handleGoogleNotification({
        body: testBody,
        headers: { Authorization: [`Bearer ${googleOidc.tokens.valid}`] },
      }),
    ).resolves.toBeDefined();
  });

  it('does not require the email claim when serviceAccountEmail is not configured', async () => {
    const { guard } = makeGuard({
      google: {
        packageName: 'com.example.app',
        serviceAccount,
        pubsub: { audience: googleOidc.audience },
      },
    });
    await expect(
      guard.handleGoogleNotification(pushRequest(testBody, googleOidc.tokens.wrongEmail)),
    ).resolves.toMatchObject({ event: 'test' });
  });
});

describe('JWKS cache', () => {
  function guardWithClock(routes: Parameters<typeof fakeFetch>[0]) {
    let now = NOW.getTime();
    const fetch = fakeFetch(routes);
    const guard = new IapGuard({
      google: {
        packageName: 'com.example.app',
        serviceAccount,
        pubsub: { audience: googleOidc.audience },
      },
      store: new MemoryPurchaseStore(),
      clock: () => new Date(now),
      http: { fetch, retries: 0 },
    });
    let message = 0;
    const send = (token: string = googleOidc.tokens.valid) =>
      guard.handleGoogleNotification(
        pushRequest(
          { ...testBody, message: { ...testBody.message, messageId: String(++message) } },
          token,
        ),
      );
    return { fetch, send, advance: (ms: number) => (now += ms) };
  }

  it('fetches once and honours Cache-Control max-age', async () => {
    const { fetch, send, advance } = guardWithClock({
      [`GET ${JWKS_URL}`]: {
        status: 200,
        body: googleOidc.jwks,
        headers: { 'Cache-Control': 'public, max-age=10' },
      },
    });
    await send();
    await send();
    expect(fetch.calls).toHaveLength(1);
    advance(11_000);
    await send();
    expect(fetch.calls).toHaveLength(2);
  });

  it('caches for one hour without Cache-Control', async () => {
    const { fetch, send, advance } = guardWithClock({
      [`GET ${JWKS_URL}`]: { status: 200, body: googleOidc.jwks },
    });
    await send();
    advance(30 * 60_000);
    await send();
    expect(fetch.calls).toHaveLength(1);
  });

  it('refetches once on an unknown kid (key rotation)', async () => {
    const { fetch, send, advance } = guardWithClock({
      [`GET ${JWKS_URL}`]: [
        { status: 200, body: { keys: [] }, headers: { 'Cache-Control': 'max-age=3600' } },
        { status: 200, body: googleOidc.jwks, headers: { 'Cache-Control': 'max-age=3600' } },
      ],
    });
    // Just fetched: an unknown kid does not trigger an immediate second fetch.
    await expect(send()).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    expect(fetch.calls).toHaveLength(1);
    advance(59_000);
    await expect(send()).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    expect(fetch.calls).toHaveLength(1);
    advance(2_000);
    await expect(send()).resolves.toMatchObject({ event: 'test' });
    expect(fetch.calls).toHaveLength(2);
    await send();
    expect(fetch.calls).toHaveLength(2);
  });

  it('a kid that stays unknown after the refetch is rejected', async () => {
    const { fetch, send, advance } = guardWithClock({
      [`GET ${JWKS_URL}`]: {
        status: 200,
        body: googleOidc.jwks,
        headers: { 'Cache-Control': 'max-age=3600' },
      },
    });
    await send();
    advance(61_000);
    await expect(send(googleOidc.tokens.unknownKid)).rejects.toMatchObject({
      code: 'INVALID_SIGNATURE',
    });
    expect(fetch.calls).toHaveLength(2);
  });

  it('ignores JWKS entries that are not RSA keys', async () => {
    const { send } = guardWithClock({
      [`GET ${JWKS_URL}`]: {
        status: 200,
        body: { keys: [{ kid: 'oidc-test-key-1', kty: 'oct', k: 'c2VjcmV0' }, 'junk'] },
      },
    });
    await expect(send()).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });

  it('a JWKS outage is a retryable StoreApiError (HTTP 500 → Pub/Sub retries)', async () => {
    const { send } = guardWithClock({ [`GET ${JWKS_URL}`]: { status: 503, body: 'down' } });
    const error = await send().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreApiError);
    expect(error).toMatchObject({ retryable: true });
  });
});

describe('verification token (?token=)', () => {
  const secret = googleRtdn.verificationToken as string;
  const guard = () =>
    new IapGuard({
      google: {
        packageName: 'com.example.app',
        serviceAccount,
        pubsub: { verificationToken: secret },
      },
      store: new MemoryPurchaseStore(),
      clock: fixedClock,
      http: { fetch: fakeFetch() },
    });

  it('accepts the token from a query object or URLSearchParams', async () => {
    await expect(
      guard().handleGoogleNotification({ body: testBody, query: { token: secret } }),
    ).resolves.toMatchObject({ event: 'test' });
    await expect(
      guard().handleGoogleNotification({
        body: testBody,
        query: new URLSearchParams({ token: secret }),
      }),
    ).resolves.toMatchObject({ event: 'test' });
  });

  it.each([
    ['a wrong token', { token: 'wrong' }],
    ['a prefix of the token', { token: secret.slice(0, -1) }],
    ['a missing token', {}],
    ['an array', { token: [secret] }],
  ])('rejects %s', async (_name, query) => {
    await expect(guard().handleGoogleNotification({ body: testBody, query })).rejects.toMatchObject(
      { code: 'INVALID_SIGNATURE' },
    );
  });

  it('rejects when no query is given', async () => {
    await expect(guard().handleGoogleNotification({ body: testBody })).rejects.toMatchObject({
      code: 'INVALID_SIGNATURE',
    });
  });
});

it('handleGoogleNotification requires pubsub.audience or pubsub.verificationToken', async () => {
  const guard = new IapGuard({
    google: { packageName: 'com.example.app', serviceAccount },
    store: new MemoryPurchaseStore(),
    http: { fetch: fakeFetch() },
  });
  await expect(guard.handleGoogleNotification({ body: testBody })).rejects.toBeInstanceOf(
    ConfigurationError,
  );
});

function withoutKid(): string {
  const [, payload, signature] = (googleOidc.tokens.valid as string).split('.');
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  return `${header}.${payload}.${signature}`;
}
