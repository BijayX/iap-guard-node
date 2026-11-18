import { readFileSync } from 'node:fs';
import { IapGuard, MemoryPurchaseStore, type IapGuardConfig } from '@bijayx/iap-guard';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};

const apple: IapGuardConfig['apple'] = {
  bundleId: env('APPLE_BUNDLE_ID'),
  appAppleId: Number(env('APPLE_APP_APPLE_ID')),
  ...(process.env.APPLE_ISSUER_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY_PATH
    ? {
        api: {
          issuerId: process.env.APPLE_ISSUER_ID,
          keyId: process.env.APPLE_KEY_ID,
          privateKey: readFileSync(process.env.APPLE_PRIVATE_KEY_PATH, 'utf8'),
        },
      }
    : {}),
};

const google: IapGuardConfig['google'] = {
  packageName: env('GOOGLE_PACKAGE_NAME'),
  serviceAccount: readFileSync(env('GOOGLE_SERVICE_ACCOUNT_PATH'), 'utf8'),
  consumableProductIds: (process.env.GOOGLE_CONSUMABLE_PRODUCT_IDS ?? '')
    .split(',')
    .filter(Boolean),
  pubsub: {
    audience: env('GOOGLE_PUBSUB_AUDIENCE'),
    serviceAccountEmail: process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL ?? null,
  },
};

/**
 * One instance per process. MemoryPurchaseStore loses everything on restart — use a
 * database-backed PurchaseStore in production (see the SQL recipe in the main README).
 */
export const guard = new IapGuard({
  apple,
  google,
  store: new MemoryPurchaseStore(),
  accountTokenSecret: env('IAP_ACCOUNT_TOKEN_SECRET'),
  logger: console,
});
