import { describe, expect, it } from 'vitest';
import { IapGuard } from '../../src/index.js';
import {
  ACCOUNT_SECRET,
  TOKEN_URL,
  appleApi,
  appleApiKey,
  appleJws,
  googleApi,
  googleOidc,
  googleRtdn,
  makeGuard,
  pushRequest,
  serviceAccount,
  subscriptionRoute,
  subscriptionUrl,
  ackSubscriptionUrl,
} from '../helpers/fixtures.js';

/** Strings that must never appear in an error (message, details, cause chain) or a log line. */
const SECRETS = [
  appleApiKey.split('\n')[1]!, // a line of the .p8 key body
  (serviceAccount.private_key as string).split('\n')[1]!,
  'PRIVATE KEY',
  googleApi.oauth.tokenResponse.access_token as string,
  ACCOUNT_SECRET,
  'eyJ', // any JWT / JWS (Apple API bearer token, OAuth assertion, OIDC token)
  'user-A', // another user's id
  googleRtdn.verificationToken as string,
];

function dump(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message, JSON.stringify(current), current.stack ?? '');
    current = current.cause;
  }
  return parts.join('\n');
}

describe('secrets never reach errors or logs', () => {
  it('across Apple, Google, OAuth, OIDC and ownership failures', async () => {
    const PROD = appleApi.baseUrls.production as string;
    const notFound = { status: 404, body: appleApi.responses.transactionNotFound.body };
    const { guard, logs } = makeGuard({
      appleApi: true,
      accountTokenSecret: ACCOUNT_SECRET,
      routes: {
        [`GET ${PROD}/inApps/v1/transactions/1`]: { status: 401, body: '' },
        [`GET ${PROD}/inApps/v1/transactions/2`]: { status: 500, body: { errorCode: 5000000 } },
        [`GET ${PROD}/inApps/v1/subscriptions/2000000000000100`]: notFound,
        [`GET ${PROD}/inApps/v1/subscriptions/2000000000000002`]: notFound,
        [`GET ${subscriptionUrl('bad')}`]: { status: 403, body: googleApi.errors.forbidden.body },
        ...Object.fromEntries([subscriptionRoute('active')]),
        [`POST ${ackSubscriptionUrl('premium_monthly', 'gp-sub-token-1')}`]: {
          status: 500,
          body: 'x',
        },
      },
    });
    const errors: unknown[] = [];
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (error) {
        errors.push(error);
      }
    };

    await attempt(() => guard.verify({ platform: 'apple', transactionId: '1' }));
    await attempt(() => guard.verify({ platform: 'apple', transactionId: '2' }));
    await attempt(() =>
      guard.verify({ platform: 'google', type: 'subscription', purchaseToken: 'bad' }),
    );
    await attempt(() =>
      guard.claim({
        userId: 'user-A',
        platform: 'apple',
        signedTransaction: appleJws.transactions.subscriptionNoToken.jws,
      }),
    );
    await attempt(() =>
      guard.claim({
        userId: 'user-B',
        platform: 'apple',
        signedTransaction: appleJws.transactions.subscriptionNoToken.jws,
      }),
    );
    await attempt(() =>
      guard.claim({
        userId: 'user-B',
        platform: 'apple',
        signedTransaction: appleJws.transactions.subscriptionActive.jws,
      }),
    );
    await attempt(() =>
      guard.claim({
        userId: 'user-1',
        platform: 'google',
        type: 'subscription',
        purchaseToken: 'gp-sub-token-1',
      }),
    );
    await attempt(() =>
      guard.handleGoogleNotification(
        pushRequest(googleRtdn.notifications.test.body, googleOidc.tokens.tamperedClaims),
      ),
    );
    await attempt(() =>
      guard.verify({ platform: 'apple', signedTransaction: appleJws.invalidSignatures.rogueChain }),
    );

    expect(errors.map((e) => (e as { code: string }).code)).toEqual([
      'AUTHENTICATION_FAILED',
      'STORE_API_ERROR',
      'AUTHENTICATION_FAILED',
      'ALREADY_OWNED',
      'ACCOUNT_MISMATCH',
      'INVALID_SIGNATURE',
      'INVALID_SIGNATURE',
    ]);
    expect(logs.some((log) => log.message.includes('acknowledge failed'))).toBe(true);

    const text = errors.map(dump).join('\n') + JSON.stringify(logs);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });

  it('OAuth token failures', async () => {
    const { guard, logs } = makeGuard({
      routes: { [`POST ${TOKEN_URL}`]: { status: 401, body: googleApi.oauth.tokenError.body } },
    });
    const error = await guard
      .verify({ platform: 'google', type: 'subscription', purchaseToken: 't' })
      .catch((e: unknown) => e);
    const text = dump(error) + JSON.stringify(logs);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });

  it('configuration errors', () => {
    const bad = [
      () =>
        new IapGuard({
          apple: {
            bundleId: 'x',
            api: { issuerId: 'i', keyId: 'k', privateKey: appleApiKey.replace('A', '!') },
          },
        }),
      () =>
        new IapGuard({
          google: {
            packageName: 'p',
            serviceAccount: { ...serviceAccount, private_key: appleApiKey },
          },
        }),
      () =>
        new IapGuard({ apple: { bundleId: 'x' }, accountTokenSecret: ACCOUNT_SECRET.slice(0, 10) }),
    ];
    for (const build of bad) {
      let error: unknown;
      try {
        build();
      } catch (e) {
        error = e;
      }
      expect(error).toBeDefined();
      const text = dump(error);
      for (const secret of [...SECRETS, ACCOUNT_SECRET.slice(0, 10)])
        expect(text).not.toContain(secret);
    }
  });
});
