import { createPrivateKey, type KeyObject } from 'node:crypto';
import { ConfigurationError } from '../core/errors/index.js';
import { isRecord, nonEmpty } from '../core/guards.js';

export const GOOGLE_DEFAULTS = Object.freeze({
  baseUrl: 'https://androidpublisher.googleapis.com/androidpublisher/v3/',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  scope: 'https://www.googleapis.com/auth/androidpublisher',
});

/** The JSON key file of a service account with access to the Play Console app. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface PubSubConfig {
  /** Verify the Pub/Sub push OIDC token: its `aud` must equal this (recommended). */
  audience?: string;
  /** When set, the OIDC token's `email` must equal it (and be verified). */
  serviceAccountEmail?: string | null;
  /** Shared secret expected as `?token=` on the push URL (simpler, weaker). */
  verificationToken?: string;
}

export interface GoogleConfig {
  packageName: string;
  /** Service-account key as a JSON string or parsed object. */
  serviceAccount: string | ServiceAccountKey;
  /** Play doesn't say which products are consumable; these are consumed after a claim. */
  consumableProductIds?: readonly string[];
  /** Default true. False → license-tester purchases throw `ENVIRONMENT_NOT_ALLOWED`. */
  allowTestPurchases?: boolean;
  /** Required for `handleGoogleNotification`. */
  pubsub?: PubSubConfig;
  baseUrl?: string;
  tokenUrl?: string;
  jwksUrl?: string;
}

export interface ResolvedGoogleConfig {
  packageName: string;
  clientEmail: string;
  privateKey: KeyObject;
  consumableProductIds: ReadonlySet<string>;
  allowTestPurchases: boolean;
  pubsub: {
    audience: string | null;
    serviceAccountEmail: string | null;
    verificationToken: string | null;
  };
  baseUrl: string;
  tokenUrl: string;
  jwksUrl: string;
}

export function resolveGoogleConfig(config: GoogleConfig): ResolvedGoogleConfig {
  const problem = (message: string) =>
    new ConfigurationError(`google: ${message}`, { platform: 'google' });

  if (!nonEmpty(config.packageName)) throw problem('packageName is required');

  let account: unknown = config.serviceAccount;
  if (typeof account === 'string') {
    try {
      account = JSON.parse(account);
    } catch {
      throw problem('serviceAccount is not valid JSON');
    }
  }
  if (!isRecord(account) || !nonEmpty(account.client_email) || !nonEmpty(account.private_key)) {
    throw problem('serviceAccount must contain client_email and private_key');
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(account.private_key);
  } catch {
    throw problem('serviceAccount.private_key is not a valid PEM private key');
  }
  if (privateKey.asymmetricKeyType !== 'rsa') {
    throw problem('serviceAccount.private_key must be an RSA key');
  }

  const pubsub = config.pubsub ?? {};
  const audience = nonEmpty(pubsub.audience) ? pubsub.audience : null;
  const verificationToken = nonEmpty(pubsub.verificationToken) ? pubsub.verificationToken : null;
  const tokenUri = nonEmpty(account.token_uri) ? account.token_uri : null;

  return {
    packageName: config.packageName,
    clientEmail: account.client_email,
    privateKey,
    consumableProductIds: new Set(config.consumableProductIds ?? []),
    allowTestPurchases: config.allowTestPurchases ?? true,
    pubsub: {
      audience,
      serviceAccountEmail: nonEmpty(pubsub.serviceAccountEmail) ? pubsub.serviceAccountEmail : null,
      verificationToken,
    },
    baseUrl: withTrailingSlash(config.baseUrl ?? GOOGLE_DEFAULTS.baseUrl),
    tokenUrl: config.tokenUrl ?? tokenUri ?? GOOGLE_DEFAULTS.tokenUrl,
    jwksUrl: config.jwksUrl ?? GOOGLE_DEFAULTS.jwksUrl,
  };
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}
