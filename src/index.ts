// Public API. Everything exported here follows semver.

export { IapGuard, type IapGuardConfig } from './iap-guard.js';

export type {
  AppleSignedTransactionInput,
  AppleTransactionIdInput,
  AppleVerifyInput,
  ClaimInput,
  ClaimResult,
  ConflictPolicy,
  Environment,
  GoogleVerifyInput,
  Logger,
  NotificationEvent,
  NotificationResult,
  Ownership,
  Platform,
  ProductType,
  Purchase,
  PurchaseStatus,
  VerifyInput,
  WebhookRequest,
} from './core/types.js';

export type { AppleApiConfig, AppleConfig } from './apple/apple.config.js';
export { APPLE_ROOT_CA_G3_PEM } from './apple/apple-root-ca-g3.js';
export type { GoogleConfig, PubSubConfig, ServiceAccountKey } from './google/google.config.js';

export type { Clock } from './core/clock.js';
export type { FetchLike, HttpOptions } from './core/http/http-client.js';
export { isEntitled } from './core/entitlement.js';
export { deriveAccountToken } from './core/account-token.js';
export { serializePurchase, deserializePurchase } from './core/purchase.js';

export type { PurchaseRecord, PurchaseStore } from './store/purchase-store.js';
export { MemoryPurchaseStore } from './store/memory-store.js';

export {
  toWebhookResponse,
  webhookResponse,
  type WebhookResponse,
} from './http/webhook-response.js';

export {
  AuthenticationError,
  ConfigurationError,
  ErrorCode,
  IapError,
  NetworkError,
  OwnershipError,
  PolicyError,
  PurchaseNotFoundError,
  StoreApiError,
  ValidationError,
  VerificationError,
  isIapError,
  type IapErrorOptions,
  type OwnershipErrorCode,
  type PolicyErrorCode,
  type StoreApiErrorOptions,
  type VerificationErrorCode,
} from './core/errors/index.js';
