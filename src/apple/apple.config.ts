import { createPrivateKey, type KeyObject } from 'node:crypto';
import { ConfigurationError } from '../core/errors/index.js';
import { nonEmpty } from '../core/guards.js';
import type { Environment } from '../core/types.js';
import { loadRoot, type TrustedRoot } from '../crypto/x509-chain.js';
import { APPLE_ROOT_CA_G3_PEM } from './apple-root-ca-g3.js';

export const APPLE_BASE_URLS: Readonly<Record<Environment, string>> = Object.freeze({
  production: 'https://api.storekit.itunes.apple.com',
  sandbox: 'https://api.storekit-sandbox.itunes.apple.com',
});

/** App Store Server API credentials (App Store Connect → Users and Access → Integrations). */
export interface AppleApiConfig {
  issuerId: string;
  keyId: string;
  /** Contents of the `.p8` file (PKCS#8 PEM). */
  privateKey: string;
  /** Override for tests or proxies. */
  baseUrls?: Partial<Record<Environment, string>>;
}

export interface AppleConfig {
  bundleId: string;
  /** Numeric App Store app id. Required to handle production notifications. */
  appAppleId?: number | null;
  /**
   * Default `['production', 'sandbox']`. App Review tests your production server with sandbox
   * purchases — keep sandbox allowed and use `purchase.environment` to separate revenue.
   */
  environments?: readonly Environment[];
  /** Default true. */
  allowFamilySharing?: boolean;
  /** Trust anchors (PEM or DER). Default: the bundled Apple Root CA - G3. */
  rootCertificates?: readonly (string | Uint8Array)[];
  /** Enables `verify({ transactionId })` and live subscription status lookups. */
  api?: AppleApiConfig | null;
}

export interface ResolvedAppleApiConfig {
  issuerId: string;
  keyId: string;
  privateKey: KeyObject;
  baseUrls: Record<Environment, string>;
}

export interface ResolvedAppleConfig {
  bundleId: string;
  appAppleId: number | null;
  environments: readonly Environment[];
  allowFamilySharing: boolean;
  roots: readonly TrustedRoot[];
  api: ResolvedAppleApiConfig | null;
}

const ENVIRONMENTS: readonly Environment[] = ['production', 'sandbox'];

export function resolveAppleConfig(config: AppleConfig): ResolvedAppleConfig {
  const problem = (message: string) =>
    new ConfigurationError(`apple: ${message}`, { platform: 'apple' });

  if (!nonEmpty(config.bundleId)) throw problem('bundleId is required');
  const appAppleId = config.appAppleId ?? null;
  if (appAppleId !== null && (!Number.isSafeInteger(appAppleId) || appAppleId <= 0)) {
    throw problem('appAppleId must be a positive integer');
  }
  const environments = [...(config.environments ?? ENVIRONMENTS)];
  if (environments.length === 0 || environments.some((env) => !ENVIRONMENTS.includes(env))) {
    throw problem('environments must be a non-empty subset of ["production", "sandbox"]');
  }

  const sources = config.rootCertificates ?? [APPLE_ROOT_CA_G3_PEM];
  if (sources.length === 0) throw problem('rootCertificates must not be empty');
  const roots = sources.map((source, index) => {
    try {
      return loadRoot(source);
    } catch (error) {
      throw new ConfigurationError(`apple: rootCertificates[${index}] is not a certificate`, {
        platform: 'apple',
        cause: error,
      });
    }
  });

  return {
    bundleId: config.bundleId,
    appAppleId,
    environments: Object.freeze(environments),
    allowFamilySharing: config.allowFamilySharing ?? true,
    roots: Object.freeze(roots),
    api: config.api ? resolveApi(config.api) : null,
  };
}

function resolveApi(api: AppleApiConfig): ResolvedAppleApiConfig {
  if (!nonEmpty(api.issuerId) || !nonEmpty(api.keyId)) {
    throw new ConfigurationError('apple.api: issuerId and keyId are required', {
      platform: 'apple',
    });
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(api.privateKey);
  } catch {
    // Never echo the key material.
    throw new ConfigurationError('apple.api: privateKey is not a valid PKCS#8 PEM (.p8) key', {
      platform: 'apple',
    });
  }
  if (privateKey.asymmetricKeyType !== 'ec') {
    throw new ConfigurationError('apple.api: privateKey must be an EC P-256 key', {
      platform: 'apple',
    });
  }
  return {
    issuerId: api.issuerId,
    keyId: api.keyId,
    privateKey,
    baseUrls: { ...APPLE_BASE_URLS, ...stripTrailingSlashes(api.baseUrls ?? {}) },
  };
}

function stripTrailingSlashes(
  urls: Partial<Record<Environment, string>>,
): Partial<Record<Environment, string>> {
  const out: Partial<Record<Environment, string>> = {};
  for (const env of ENVIRONMENTS) {
    const url = urls[env];
    if (url !== undefined) out[env] = url.replace(/\/+$/, '');
  }
  return out;
}
