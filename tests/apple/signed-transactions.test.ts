import { createHash, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APPLE_ROOT_CA_G3_PEM,
  ConfigurationError,
  IapGuard,
  PolicyError,
  ValidationError,
  VerificationError,
} from '../../src/index.js';
import {
  appleJws,
  fixedClock,
  makeGuard,
  plain,
  rootPem,
  serviceAccount,
} from '../helpers/fixtures.js';

/** Each invalid fixture must fail for its own reason, not by accident. */
const REASONS: Record<string, string> = {
  tampered: 'signature does not match',
  rogueChain: 'not signed by a trusted root',
  rogueChainWithTrustedRootInX5c: 'not signed by a trusted root',
  leafNotSignedByIntermediate: 'leaf is not signed by the intermediate',
  signedByIntermediateKey: 'signature does not match',
  leafWithoutAppleOid: 'leaf lacks the Apple OID',
  intermediateWithoutAppleOid: 'intermediate lacks the Apple OID',
  intermediateNotCa: 'intermediate is not a CA',
  expiredLeaf: 'not valid at signedDate',
  twoCertChain: 'exactly three certificates',
  noX5c: 'exactly three certificates',
  algHS256: 'alg must be ES256',
  algNone: 'alg must be ES256',
  derSignature: 'signature does not match',
  missingSignedDate: 'signedDate missing',
  notJws: 'not a compact JWS',
  fourSegments: 'not a compact JWS',
  payloadNotJson: 'not a compact JWS',
};

const transactions = Object.entries<any>(appleJws.transactions);

describe('Apple signed transactions (fixtures/apple/jws.json)', () => {
  const { guard } = makeGuard();

  describe.each(transactions.filter(([, t]) => t.expected))('%s', (_name, fixture) => {
    it('verifies and normalizes to the expected Purchase', async () => {
      const purchase = await guard.verify({ platform: 'apple', signedTransaction: fixture.jws });
      expect(plain(purchase)).toEqual(fixture.expected);
      expect(Object.isFrozen(purchase)).toBe(true);
      expect(purchase.raw.transaction).toEqual(fixture.payload);
    });
  });

  describe.each(transactions.filter(([, t]) => t.expectedError))('%s', (_name, fixture) => {
    it(`fails with ${fixture.expectedError}`, async () => {
      await expect(
        guard.verify({ platform: 'apple', signedTransaction: fixture.jws }),
      ).rejects.toMatchObject({ code: fixture.expectedError, platform: 'apple' });
    });
  });

  describe.each(Object.entries<string>(appleJws.invalidSignatures))(
    'invalid signature: %s',
    (_name, jws) => {
      it('fails with INVALID_SIGNATURE', async () => {
        const error = await guard
          .verify({ platform: 'apple', signedTransaction: jws })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(VerificationError);
        expect(error).toMatchObject({ code: 'INVALID_SIGNATURE' });
        expect((error as Error).message).toContain(REASONS[_name]);
      });
    },
  );

  it('documents a reason for every invalid fixture', () => {
    expect(Object.keys(REASONS).sort()).toEqual(Object.keys(appleJws.invalidSignatures).sort());
  });

  it('rejects signedDate more than 60 s in the future (clock skew)', async () => {
    await expect(
      guard.verify({
        platform: 'apple',
        signedTransaction: appleJws.transactions.futureSigned.jws,
      }),
    ).rejects.toThrow('signedDate is in the future');
  });

  it('rejects Xcode / StoreKit-testing environments', async () => {
    await expect(
      guard.verify({ platform: 'apple', signedTransaction: appleJws.transactions.xcode.jws }),
    ).rejects.toThrow('not from the App Store');
  });

  it('rejects the fixtures when only the real Apple root is trusted', async () => {
    const real = new IapGuard({ apple: { bundleId: 'com.example.app' }, clock: fixedClock });
    await expect(
      real.verify({
        platform: 'apple',
        signedTransaction: appleJws.transactions.subscriptionActive.jws,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });

  it('accepts a DER root certificate', async () => {
    const der = new X509Certificate(rootPem).raw;
    const derGuard = new IapGuard({
      apple: { bundleId: 'com.example.app', rootCertificates: [der] },
      clock: fixedClock,
    });
    const purchase = await derGuard.verify({
      platform: 'apple',
      signedTransaction: appleJws.transactions.nonConsumable.jws,
    });
    expect(purchase.productId).toBe('lifetime_unlock');
  });

  it('rejects a signedTransaction that is not a string', async () => {
    await expect(
      guard.verify({ platform: 'apple', signedTransaction: 42 as unknown as string }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a validly signed payload that is not a transaction', async () => {
    // Renewal info is signed by the same chain but lacks transaction fields.
    await expect(
      guard.verify({ platform: 'apple', signedTransaction: appleJws.renewals.renewalActive.jws }),
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });
});

describe('Apple policies', () => {
  it('ENVIRONMENT_NOT_ALLOWED for sandbox when only production is allowed', async () => {
    const { guard } = makeGuard({
      apple: {
        bundleId: 'com.example.app',
        rootCertificates: [rootPem],
        environments: ['production'],
      },
    });
    const error = await guard
      .verify({ platform: 'apple', signedTransaction: appleJws.transactions.sandbox.jws })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyError);
    expect(error).toMatchObject({
      code: 'ENVIRONMENT_NOT_ALLOWED',
      details: { environment: 'sandbox' },
    });
  });

  it('FAMILY_SHARING_NOT_ALLOWED when family sharing is disabled', async () => {
    const { guard } = makeGuard({
      apple: {
        bundleId: 'com.example.app',
        rootCertificates: [rootPem],
        allowFamilySharing: false,
      },
    });
    await expect(
      guard.verify({
        platform: 'apple',
        signedTransaction: appleJws.transactions.familyShared.jws,
      }),
    ).rejects.toMatchObject({ code: 'FAMILY_SHARING_NOT_ALLOWED' });
  });

  it('UNKNOWN_PRODUCT for products outside the allowlist', async () => {
    const { guard } = makeGuard({ products: ['premium_monthly'] });
    await expect(
      guard.verify({
        platform: 'apple',
        signedTransaction: appleJws.transactions.nonConsumable.jws,
      }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_PRODUCT', details: { productId: 'lifetime_unlock' } });
    await expect(
      guard.verify({
        platform: 'apple',
        signedTransaction: appleJws.transactions.subscriptionActive.jws,
      }),
    ).resolves.toMatchObject({ productId: 'premium_monthly' });
  });

  it('verify by transactionId requires apple.api', async () => {
    const { guard } = makeGuard();
    await expect(
      guard.verify({ platform: 'apple', transactionId: '2000000000000200' }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe('Apple configuration', () => {
  it.each([
    [{ bundleId: '' }, 'bundleId'],
    [{ bundleId: 'x', appAppleId: -1 }, 'appAppleId'],
    [{ bundleId: 'x', environments: [] }, 'environments'],
    [{ bundleId: 'x', environments: ['staging'] }, 'environments'],
    [{ bundleId: 'x', rootCertificates: [] }, 'rootCertificates'],
    [{ bundleId: 'x', rootCertificates: ['not a cert'] }, 'rootCertificates[0]'],
    [{ bundleId: 'x', api: { issuerId: '', keyId: 'k', privateKey: 'x' } }, 'issuerId'],
    [{ bundleId: 'x', api: { issuerId: 'i', keyId: 'k', privateKey: 'nope' } }, 'privateKey'],
  ])('rejects %j', (apple, fragment) => {
    expect(() => new IapGuard({ apple: apple as never })).toThrow(
      expect.objectContaining({
        code: 'CONFIGURATION_ERROR',
        message: expect.stringContaining(fragment),
      }),
    );
  });

  it('rejects a non-EC App Store API key without echoing it', () => {
    const rsa = serviceAccount.private_key as string;
    let error: unknown;
    try {
      new IapGuard({
        apple: { bundleId: 'x', api: { issuerId: 'i', keyId: 'k', privateKey: rsa } },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(JSON.stringify(error)).not.toContain('PRIVATE KEY');
  });
});

describe('bundled Apple Root CA - G3', () => {
  it('has the published SHA-256 fingerprint', () => {
    const certificate = new X509Certificate(APPLE_ROOT_CA_G3_PEM);
    expect(certificate.fingerprint256).toBe(
      '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79',
    );
    const digest = createHash('sha256').update(certificate.raw).digest('hex').toUpperCase();
    expect(digest.match(/../g)!.join(':')).toBe(certificate.fingerprint256);
    expect(certificate.subject).toContain('CN=Apple Root CA - G3');
    expect(new Date(certificate.validTo).getUTCFullYear()).toBe(2039);
  });
});
