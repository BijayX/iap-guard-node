# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - unreleased

### Added

- `IapGuard` with `verify`, `claim`, `handleAppleNotification`, `handleGoogleNotification`,
  `entitlements`, `isEntitled`, `releaseUser` and `accountTokenFor`.
- Apple: StoreKit 2 JWS verification with `node:crypto` only (x5c chain to Apple Root CA - G3,
  Apple marker OIDs via a DER reader, validity at `signedDate`, raw ES256 signatures), App Store
  Server API client (transaction lookup with production → sandbox fallback, subscription
  status), App Store Server Notifications V2.
- Google: Play Developer API (`subscriptionsv2`, `productsv2`, acknowledge, consume) with a
  service-account OAuth token cache shared by concurrent callers; RTDN via Pub/Sub push with
  OIDC (JWKS cache) or verification-token authentication.
- Ownership: one owner per purchase, Google upgrade chains via `linkedPurchaseToken`,
  account tokens (`appAccountToken` / `obfuscatedAccountId`), `reject` and `transfer` conflict
  policies, optimistic concurrency, stale-state protection, notification dedupe, and
  `PurchaseRecord.claimedAt` so webhook-first consumables are granted once and released ones
  never twice.
- `PurchaseStore` interface, `MemoryPurchaseStore`, `serializePurchase` / `deserializePurchase`.
- `toWebhookResponse` / `webhookResponse` helpers mapping results and errors to HTTP statuses.
- Typed errors with stable codes; secrets never appear in errors or logs.
