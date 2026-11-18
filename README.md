# @bijayx/iap-guard

Server-side verification **and ownership protection** for Apple App Store and Google Play
in-app purchases, behind one typed API.

- **One API for both stores.** `claim()` takes a StoreKit 2 signed transaction or a Play
  purchase token and returns the same normalized `Purchase`, with the same statuses on both
  platforms.
- **Purchases belong to your users, not to devices.** Each purchase has exactly one owner in
  your system. Restores, second devices, upgrades, family sharing, refunds and webhooks that
  arrive before the app call are all handled ([18 edge cases](#edge-cases-handled)).
- **Verification done right.** Apple JWS chains are checked against Apple Root CA - G3 with
  `node:crypto` only. Google state always comes from the Play Developer API, never from the
  client or the notification body. Pub/Sub pushes are authenticated with OIDC.
- **Typed errors** with stable codes, safe to log. Keys, tokens, JWTs and other users' ids never
  appear in messages or logs.
- **Zero runtime dependencies.** Node.js 20+, ESM and CommonJS, full TypeScript types.

```bash
npm install @bijayx/iap-guard
```

## Contents

- [Why this exists](#why-this-exists)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Client side](#client-side): [StoreKit 2](#ios-storekit-2) · [Play Billing](#android-play-billing)
- [Claiming purchases](#claiming-purchases)
- [Webhooks](#webhooks)
- [Entitlements](#entitlements)
- [Edge cases handled](#edge-cases-handled)
- [Conflict policies and account tokens](#conflict-policies-and-account-tokens)
- [Configuration](#configuration)
- [Errors](#errors)
- [Security checklist](#security-checklist)
- [Store setup](#store-setup): [App Store Server Notifications V2](#app-store-server-notifications-v2) · [Play RTDN](#google-play-rtdn-pubsub-push-with-oidc)
- [PurchaseStore: SQL recipe](#purchasestore-sql-recipe)
- [Testing with sandbox accounts](#testing-with-sandbox-accounts)
- [Limitations](#limitations)

## Why this exists

Checking that a receipt is genuine is the easy half. The hard half is deciding **who** it
belongs to:

- Two people share an iPad and an Apple ID, but have separate accounts in your app. The second
  one taps "Restore purchases". Should they get the first one's subscription?
- A user upgrades their Play subscription. Google issues a _new_ purchase token. Is that a new
  purchase, or the same one?
- The App Store tells your webhook about a renewal before the app has ever called your server.
- A client replays an old consumable receipt to collect the coins again.

`iap-guard` answers these the same way on both stores, behind one API. Each purchase gets a
stable **ownership key**, and each key has at most one owner. Whoever owns it is entitled on
every device and on both platforms. The full contract, shared with the Laravel package
[`bijayx/iap-guard-laravel`](https://github.com/BijayX/iap-guard-laravel), is in
[SPEC.md](SPEC.md).

## Quick start

```ts
import { readFileSync } from 'node:fs';
import { IapGuard, MemoryPurchaseStore } from '@bijayx/iap-guard';

const guard = new IapGuard({
  apple: {
    bundleId: 'com.example.app',
    appAppleId: 1234567890, // App Store Connect → App Information → Apple ID
  },
  google: {
    packageName: 'com.example.app',
    serviceAccount: readFileSync('service-account.json', 'utf8'),
    consumableProductIds: ['coins_100'],
    pubsub: { audience: 'https://api.example.com/webhooks/google' },
  },
  store: new MemoryPurchaseStore(), // use a database-backed store in production
  accountTokenSecret: process.env.IAP_ACCOUNT_TOKEN_SECRET, // ≥ 32 chars
});

// The app sends proof of a purchase; the user id comes from YOUR authentication.
const result = await guard.claim({
  userId: session.userId,
  platform: 'apple',
  signedTransaction: req.body.signedTransaction,
});

if (result.isEntitled) unlockPremium(session.userId);
if (result.isNew && result.purchase.type === 'consumable') {
  grantCoins(session.userId, 100 * result.purchase.quantity); // exactly once
}
```

## How it works

```
verify()                 stateless: proves a purchase is genuine and normalizes it
claim()                  verify + ownership rules + persistence + Google acknowledge/consume
handle*Notification()    authenticate webhook + dedupe + refresh state + persist
entitlements()           what a user may access right now, across platforms and devices
```

`verify()` needs no database. Everything else uses a [`PurchaseStore`](#purchasestore-sql-recipe).

| platform | product type                                 | ownership key                                               |
| -------- | -------------------------------------------- | ----------------------------------------------------------- |
| apple    | auto-renewable, non-consumable, non-renewing | `originalTransactionId`                                     |
| apple    | consumable                                   | `transactionId`                                             |
| google   | subscription                                 | the first purchase token of the `linkedPurchaseToken` chain |
| google   | one-time product                             | `purchaseToken`                                             |

Every purchase is normalized to the same shape:

```ts
interface Purchase {
  platform: 'apple' | 'google';
  key: string; // ownership key
  productId: string;
  productIds: string[]; // Google bundles can have several
  type: 'subscription' | 'non_consumable' | 'consumable' | 'non_renewing_subscription';
  status:
    | 'pending'
    | 'active'
    | 'grace_period'
    | 'billing_retry'
    | 'paused'
    | 'expired'
    | 'revoked'
    | 'canceled';
  environment: 'production' | 'sandbox';
  transactionId: string; // Apple transactionId / Google order id
  originalTransactionId: string | null; // Apple
  purchaseToken: string | null; // Google, current token
  linkedPurchaseToken: string | null;
  purchasedAt: Date;
  expiresAt: Date | null;
  gracePeriodExpiresAt: Date | null;
  willRenew: boolean | null;
  autoRenewProductId: string | null; // Apple pending downgrade
  accountToken: string | null; // appAccountToken / obfuscatedExternalAccountId
  quantity: number;
  familyShared: boolean;
  acknowledged: boolean | null; // Google
  revokedAt: Date | null;
  signedAt: Date; // when this state was produced
  raw: Record<string, unknown>; // decoded store payloads
}
```

## Client side

The app's job is to (1) tag the purchase with an **account token** from your server and
(2) send the proof to your server. It never decides access on its own.

### iOS (StoreKit 2)

```swift
// 1. Ask your server for this user's account token (GET /me/account-token).
let token = try await api.accountToken()

// 2. Purchase, binding the transaction to your user.
let result = try await product.purchase(options: [
    .appAccountToken(UUID(uuidString: token)!)
])

// 3. Send the signed transaction (a JWS) to your server, then finish it.
if case .success(let verification) = result {
    try await api.claim(["platform": "apple",
                         "signedTransaction": verification.jwsRepresentation])
    if case .verified(let transaction) = verification { await transaction.finish() }
}

// Restores, other devices, renewals while the app was closed:
for await verification in Transaction.currentEntitlements {
    try await api.claim(["platform": "apple",
                         "signedTransaction": verification.jwsRepresentation])
}
// Also listen to Transaction.updates for purchases made outside the app (Ask to Buy, offer codes…).
```

Send `jwsRepresentation`, not the decoded transaction: the server verifies Apple's signature
itself. StoreKit's on-device `.verified` check is not a substitute.

### Android (Play Billing)

```kotlin
// 1. Ask your server for this user's account token (GET /me/account-token).
val accountToken = api.accountToken()

// 2. Purchase, binding it to your user.
val params = BillingFlowParams.newBuilder()
    .setProductDetailsParamsList(listOf(
        BillingFlowParams.ProductDetailsParams.newBuilder()
            .setProductDetails(productDetails)
            .setOfferToken(offerToken) // subscriptions only
            .build()
    ))
    .setObfuscatedAccountId(accountToken)
    .build()
billingClient.launchBillingFlow(activity, params)

// 3. In onPurchasesUpdated (and after queryPurchasesAsync for restores):
for (purchase in purchases) {
    api.claim(mapOf(
        "platform" to "google",
        "type" to if (isSubscription) "subscription" else "one_time",
        "purchaseToken" to purchase.purchaseToken,
        "productId" to purchase.products.first(),
    ))
}
```

Don't acknowledge or consume on the device. The server does it after the purchase is
recorded (see [§7.7](SPEC.md)). Products listed in `consumableProductIds` are consumed;
everything else is acknowledged. Play refunds purchases that aren't acknowledged within three
days, so if acknowledging fails the claim still succeeds, and the next claim or notification
retries it.

## Claiming purchases

```ts
const result = await guard.claim({
  userId,
  platform: 'google',
  type: 'subscription',
  purchaseToken,
  productId,
});
```

| field            | meaning                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `purchase`       | Stored state after the claim. It may be newer than the proof the app sent.                    |
| `isEntitled`     | Access right now (time-based: an `active` subscription stops at `expiresAt`).                 |
| `isNew`          | First time any user has claimed this transaction/token. **Grant consumables only when true.** |
| `ownership`      | `created` (first owner), `existing` (already this user's) or `transferred`.                   |
| `previousUserId` | Set when `transferred`: revoke what you granted that user.                                    |
| `otherActive`    | The user's other entitled purchases (e.g. already subscribed on the other platform).          |

`claim` throws on anything that isn't genuine, isn't for your app, or belongs to someone else:

```ts
import { OwnershipError, PolicyError, VerificationError } from '@bijayx/iap-guard';

try {
  await guard.claim(input);
} catch (error) {
  if (error instanceof OwnershipError) return res.status(409).json({ error: error.code }); // ALREADY_OWNED, ACCOUNT_MISMATCH
  if (error instanceof VerificationError) return res.status(400).json({ error: error.code }); // INVALID_SIGNATURE, WRONG_APP, PRODUCT_MISMATCH
  if (error instanceof PolicyError) return res.status(400).json({ error: error.code }); // ENVIRONMENT_NOT_ALLOWED, UNKNOWN_PRODUCT, …
  throw error; // StoreApiError / NetworkError: retry later
}
```

`verify(input)` does the same checks without ownership or persistence, if all you need is
"is this genuine?".

Apple also accepts `{ platform: 'apple', transactionId }`. That requires `apple.api` and looks
the transaction up in production first, then sandbox. With `apple.api` configured,
auto-renewable subscriptions are also refreshed from the App Store Server API, so a stale JWS
from the device still produces the latest status and renewal info.

## Webhooks

Both handlers return a `NotificationResult` and never change who owns a purchase. Unknown
purchases are stored unowned (`userId: null`) until the first matching `claim`.
`webhookResponse()` maps the outcome to an HTTP status:

| outcome                                                                                                   | status | the store…    |
| --------------------------------------------------------------------------------------------------------- | ------ | ------------- |
| processed, duplicate, or stale                                                                            | 200    | stops         |
| `VerificationError` / `PolicyError` / `ValidationError` (forged, malformed, other app, refused by policy) | 400    | —             |
| anything else: database, network, store API, configuration, `AuthenticationError` (your own credentials)  | 500    | retries later |

Notifications don't apply the family-sharing, test-purchase or `products` allowlist policies;
they just record what the store says, and `claim` enforces those policies. Apple's
environment check still applies, because it is part of JWS verification.

If processing fails after the notification was recorded for dedupe, it is forgotten again, so
the store's retry is processed instead of being treated as a duplicate.

```ts
import express from 'express';
import { webhookResponse } from '@bijayx/iap-guard';

// App Store Server Notifications V2: body is { "signedPayload": "<JWS>" }
app.post('/webhooks/apple', express.raw({ type: '*/*' }), async (req, res) => {
  const { status, body } = await webhookResponse(() => guard.handleAppleNotification(req.body));
  res.status(status).json(body);
});

// Google Play RTDN via a Pub/Sub push subscription (OIDC authentication)
app.post('/webhooks/google', express.raw({ type: '*/*' }), async (req, res) => {
  const { status, body } = await webhookResponse(async () => {
    const result = await guard.handleGoogleNotification({
      body: req.body, // raw Buffer, string or parsed object
      headers: req.headers, // Authorization: Bearer <Google-signed OIDC token>
      query: req.query, // ?token=… if you use pubsub.verificationToken instead
    });
    if (result.event === 'refunded' && result.userId) clawBack(result.userId, result.purchase);
    return result;
  });
  res.status(status).json(body);
});
```

```ts
interface NotificationResult {
  platform: 'apple' | 'google';
  id: string; // notificationUUID / Pub/Sub messageId
  event: NotificationEvent; // 'purchased' | 'renewed' | 'refunded' | 'revoked' | 'expired' | …
  rawType: string; // e.g. 'DID_RENEW/BILLING_RECOVERY', 'SUBSCRIPTION_RENEWED'
  duplicate: boolean;
  stale: boolean; // older than stored state: nothing was overwritten
  purchase: Purchase | null; // stored state after processing
  userId: string | null; // current owner (null until claimed)
  raw: Record<string, unknown>;
}
```

Google notifications are only a trigger: the handler fetches current state from the Play
Developer API and acknowledges owned purchases that still need it. Apple notifications are
verified like client input, including the signed transaction and renewal info inside them.
A complete server is in [`examples/express`](examples/express).

## Entitlements

```ts
const active = await guard.entitlements(userId); // Purchase[] entitled now, both platforms
const canWatch = active.some((p) => p.productId.startsWith('premium_'));

guard.isEntitled(purchase); // SPEC §3 rule, using the configured clock
await guard.releaseUser(userId); // account deletion, see edge case 15
```

`isEntitled` is time-based: `active` counts until `expiresAt`, and `grace_period` counts until
`gracePeriodExpiresAt` (or `expiresAt`). So a stored subscription stops granting access on time
even if a webhook is missed. Results are sorted by `expiresAt`, latest first, with lifetime
purchases first.

## Edge cases handled

Every row has a named test in [`tests/ownership/edge-cases.test.ts`](tests/ownership/edge-cases.test.ts).

| #   | scenario                                                                                  | result                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | Same user, second device (iPad after iPhone, or reinstall) restores                       | `existing`, `isNew=false`, entitled                                                                                     |
| 2   | Same user, subscribed on iOS, opens the Android app                                       | no Google purchase needed: `entitlements(userId)` already includes the Apple subscription                               |
| 3   | Two app accounts on one phone with one Apple ID / Google account: B restores A's purchase | `reject` (default) → `ALREADY_OWNED`; `transfer` → B owns it, `previousUserId = A`                                      |
| 4   | Same as 3 but the purchase carries A's account token                                      | `ACCOUNT_MISMATCH` (reject) / transfer (transfer policy)                                                                |
| 5   | Two devices of the same user claim at the same moment                                     | atomic insert + versioned replace; one creates, the other sees `existing`; never two owners                             |
| 6   | Client replays an old consumable proof                                                    | `isNew=false` → no double grant                                                                                         |
| 7   | Client sends an old (stale) subscription JWS after a newer one                            | ownership checks run, but stored state is not rolled back                                                               |
| 8   | Google upgrade/downgrade/resubscribe creates a new token with `linkedPurchaseToken`       | new token joins the existing chain (same key, same owner); the old token can't be claimed by anyone else                |
| 9   | Apple upgrade/downgrade within a subscription group                                       | same `originalTransactionId` → same record                                                                              |
| 10  | Apple Family Sharing                                                                      | each family member has their own `originalTransactionId`; `familyShared=true`; disable with `allowFamilySharing: false` |
| 11  | Webhook arrives before the app claims                                                     | record stored with `userId = null`; first claim by a matching user takes it (`created`)                                 |
| 12  | User subscribes on both platforms                                                         | both recorded; `otherActive` on the second claim lets the app warn about double billing                                 |
| 13  | Pending purchase (Google "slow card", Ask to Buy)                                         | recorded, `status=pending`, not entitled, **not acknowledged**; a later notification activates it                       |
| 14  | Refund / revoke                                                                           | notification sets `revoked`; entitlement ends; the event lets the app claw back consumables                             |
| 15  | Account deleted                                                                           | `releaseUser(userId)` sets `userId=null` so the store account can be restored into a new app account                    |
| 16  | Sandbox purchase on production server (App Review)                                        | allowed by default, `environment="sandbox"`                                                                             |
| 17  | Purchase for another app (bundle/package)                                                 | `WRONG_APP`                                                                                                             |
| 18  | Forged/tampered/self-signed JWS, Xcode/StoreKit-testing transaction                       | `INVALID_SIGNATURE`                                                                                                     |

Details worth knowing:

- **#7 / #8: stale state.** Stored state only moves forward: a proof replaces it only when its
  `signedAt` is at least the record's `lastEventAt`. For Google subscription chains, an
  _older_ token of the chain (for example the pre-upgrade token, which Google now reports as
  expired) is checked for ownership but never overwrites the current token's state.
- **#6 / #11 / #15: `claimedAt`.** Every record remembers its first successful claim.
  Records that only a webhook has stored (`ONE_TIME_CHARGE`, or an RTDN that beat the app)
  have `claimedAt = null`, so the first claim is `isNew` and a consumable is still granted,
  exactly once. `releaseUser` clears `userId` but never `claimedAt`, so a released consumable
  claimed by a new account is `isNew = false` and isn't granted again.

## Conflict policies and account tokens

What happens when user B claims a purchase that user A already owns:

| `conflictPolicy`     | result                                                                                     | use when                                                         |
| -------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `'reject'` (default) | `OwnershipError(ALREADY_OWNED)`. The message never reveals who owns it.                    | A purchase should stay with the account that bought it.          |
| `'transfer'`         | B becomes the owner, `ownership: 'transferred'`, `previousUserId: 'A'`. Revoke A's access. | "Whoever restores gets it" (like the stores' own restore model). |

**Account tokens** bind a purchase to your user at purchase time. `accountTokenFor(userId)` is
a deterministic UUID, `HMAC-SHA256(accountTokenSecret, "iap-guard:" + userId)` formatted as a
version 8 UUID. It reveals nothing about the user id and can't be forged without the secret.
The app passes it as StoreKit `appAccountToken` or Play `obfuscatedAccountId`, and the stores
sign it into the purchase.

When `accountTokenSecret` is set and a purchase carries a token, `claim` compares it
case-insensitively with `accountTokenFor(userId)`:

- `reject`: a mismatch throws `OwnershipError(ACCOUNT_MISMATCH)`, even if nobody has claimed
  the purchase yet. This stops user B from claiming a purchase that A made but hadn't sent
  to the server yet.
- `transfer`: the check is skipped and the normal ownership rules apply.

Purchases without a token (older app versions) skip the check.

## Configuration

```ts
new IapGuard({
  apple?: AppleConfig,
  google?: GoogleConfig,
  store?: PurchaseStore,                 // required for everything except verify()
  conflictPolicy?: 'reject' | 'transfer', // default 'reject'
  accountTokenSecret?: string,           // ≥ 32 chars; enables accountTokenFor() + ACCOUNT_MISMATCH
  products?: string[],                   // allowlist (both platforms) → UNKNOWN_PRODUCT
  http?: { timeoutMs?: 15000, retries?: 2, retryDelayMs?: 200, fetch?: typeof fetch },
  logger?: { debug, warn },              // console, pino, winston…
  clock?: () => Date,                    // inject in tests
});
```

Invalid configuration (bad keys, short secrets, unknown environments) throws
`ConfigurationError` from the constructor, not in the middle of a purchase.

### Apple

| key                  | default                     | notes                                                                                                                                   |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `bundleId`           | required                    | Every signed transaction and notification must match.                                                                                   |
| `appAppleId`         | `null`                      | Numeric app id. **Required to handle notifications while production is allowed.**                                                       |
| `environments`       | `['production', 'sandbox']` | App Review tests production builds with **sandbox** purchases, so keep sandbox allowed. Use `purchase.environment` to separate revenue. |
| `allowFamilySharing` | `true`                      | `false` → `FAMILY_SHARING_NOT_ALLOWED`.                                                                                                 |
| `rootCertificates`   | bundled Apple Root CA - G3  | PEM or DER. Override only for tests.                                                                                                    |
| `api`                | `null`                      | `{ issuerId, keyId, privateKey }` (contents of the `.p8`) enables the App Store Server API.                                             |
| `api.baseUrls`       | Apple's production/sandbox  | For proxies or mocks.                                                                                                                   |

The bundled root is Apple Root CA - G3, SHA-256
`63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79`
(valid until 2039). It is exported as `APPLE_ROOT_CA_G3_PEM`, and a test pins the fingerprint.

### Google

| key                                | default  | notes                                                                             |
| ---------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `packageName`                      | required | Enforced by the API URL; RTDN `packageName` must match.                           |
| `serviceAccount`                   | required | Key file JSON (string or object): `client_email`, `private_key`, `token_uri?`.    |
| `consumableProductIds`             | `[]`     | Play doesn't say which products are consumable; these are consumed after a claim. |
| `allowTestPurchases`               | `true`   | `false` → `ENVIRONMENT_NOT_ALLOWED` for license-tester purchases.                 |
| `pubsub.audience`                  | —        | Verify the Pub/Sub push OIDC token (recommended).                                 |
| `pubsub.serviceAccountEmail`       | `null`   | When set, the token's `email` must match and be verified.                         |
| `pubsub.verificationToken`         | —        | Alternative: shared secret in `?token=` on the push URL (simpler, weaker).        |
| `baseUrl` / `tokenUrl` / `jwksUrl` | Google's | For proxies or mocks.                                                             |

### HTTP behaviour

- Per-attempt timeout (`timeoutMs`, default 15 s) via `AbortSignal`.
- Retries (`retries`, default 2, backoff `200 ms · 2^n`) on network errors, 429 and 5xx, only
  where it is safe: App Store Server API GETs, and all Play Developer API calls (GETs, plus
  acknowledge/consume, which are idempotent). The OAuth token request is not retried.
  `Retry-After` is honoured up to 10 seconds; a longer one is returned as a retryable error.
- The Google access token is cached until `expires_in − 60 s`, and concurrent callers share
  one token request. The App Store API JWT is reused for up to 4 minutes of its 5-minute
  lifetime.
- The logger gets method, URL (query string dropped, purchase tokens masked), status and
  duration only. It never gets headers or bodies.

## Errors

All errors extend `IapError` with a stable `code`, `platform` and `details`, and serialize
safely with `toJSON()`.

| class                   | codes                                                                        | typical cause                                             |
| ----------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------- |
| `ConfigurationError`    | `CONFIGURATION_ERROR`                                                        | missing platform/store/secret, invalid key                |
| `ValidationError`       | `VALIDATION_ERROR` (`fields`)                                                | bad input shape, empty or over-long `userId`              |
| `VerificationError`     | `INVALID_SIGNATURE`, `WRONG_APP`, `PRODUCT_MISMATCH`, `INVALID_NOTIFICATION` | forged/tampered proof, other app, malformed webhook       |
| `PolicyError`           | `ENVIRONMENT_NOT_ALLOWED`, `UNKNOWN_PRODUCT`, `FAMILY_SHARING_NOT_ALLOWED`   | genuine, but refused by your configuration                |
| `OwnershipError`        | `ALREADY_OWNED`, `ACCOUNT_MISMATCH`                                          | belongs to another account                                |
| `PurchaseNotFoundError` | `PURCHASE_NOT_FOUND`                                                         | unknown transaction id / token (Google 400/404/410)       |
| `AuthenticationError`   | `AUTHENTICATION_FAILED`                                                      | your Apple API key or Google service account was rejected |
| `StoreApiError`         | `STORE_API_ERROR` (`statusCode`, `retryable`)                                | 429, 5xx, unexpected responses                            |
| `NetworkError`          | `NETWORK_ERROR`, `TIMEOUT`                                                   | no response                                               |
| `IapError`              | `CONCURRENT_MODIFICATION`                                                    | three optimistic-concurrency conflicts in a row           |

## Security checklist

- [ ] `userId` comes from your authentication (session/JWT), **never** from the request body.
- [ ] Access decisions use `claim()` / `entitlements()` on the server, not flags sent by the app.
- [ ] Consumables are granted only when `result.isNew` is true, and the grant itself is
      idempotent (e.g. keyed by `purchase.key`) in case your process dies mid-request.
- [ ] `accountTokenSecret` is long and random (`openssl rand -base64 48`), kept server-side,
      and the app passes `accountTokenFor(userId)` as `appAccountToken` / `obfuscatedAccountId`.
- [ ] `apple.appAppleId` is set, so production notifications for other apps are rejected.
- [ ] The Google webhook uses `pubsub.audience` + `pubsub.serviceAccountEmail` (OIDC), or at
      least a long `verificationToken` over HTTPS.
- [ ] Webhook routes read the raw body and return the status from `webhookResponse()`.
- [ ] Your `PurchaseStore` makes `insert`, `replace` and `rememberNotification` atomic (unique
      constraints + versioned `UPDATE`), and a token can belong to only one record.
- [ ] `.p8` and service-account files are not committed; load them from a secret manager.
- [ ] `products` allowlist is set if your app sells a fixed catalogue.
- [ ] You handle `refunded` / `revoked` events (claw back consumables, end access) and
      `previousUserId` when using the `transfer` policy.
- [ ] On account deletion you call `releaseUser(userId)`.

## Store setup

### App Store Server Notifications V2

1. **App Store Connect → your app → App Information → App Store Server Notifications.** Set
   the **Production Server URL** and **Sandbox Server URL** (for example
   `https://api.example.com/webhooks/apple`) and choose **Version 2**.
2. Copy the app's **Apple ID** from the same page into `apple.appAppleId`.
3. Optional, for `verify({ transactionId })` and live subscription status: **Users and Access →
   Integrations → In-App Purchase**, generate a key, then download the `.p8` (only possible once),
   and note the **Key ID** and **Issuer ID**. Pass them as `apple.api`.
4. To check the wiring, Apple's App Store Server API has a _Request a Test Notification_
   endpoint (not wrapped by this library). The resulting `TEST` notification comes back as
   `event: 'test'`.

Apple retries failed deliveries (non-2xx) several times over a few days.

### Google Play RTDN (Pub/Sub push with OIDC)

1. **Service account for the Play Developer API.** In Google Cloud, enable the _Google Play
   Android Developer API_, create a service account and a JSON key. In **Play Console → Users
   and permissions**, invite the service account's email with access to your app, including
   _View financial data_ and _Manage orders and subscriptions_. Pass the key file as
   `google.serviceAccount`.
2. **Topic.** In Pub/Sub, create a topic (e.g. `play-rtdn`) and grant
   `google-play-developer-notifications@system.gserviceaccount.com` the **Pub/Sub Publisher**
   role on it.
3. **Play Console → Monetize with Play → Monetization setup → Real-time developer notifications.** Enter
   the full topic name `projects/<project>/topics/play-rtdn`, then click **Send test
   notification**.
4. **Push subscription.** Create a subscription on the topic with delivery type **Push**,
   endpoint `https://api.example.com/webhooks/google`, and **Enable authentication** with a
   service account of your choice (e.g. `pubsub-push@<project>.iam.gserviceaccount.com`).
   Set the **audience** to your endpoint URL (or any string you choose).
5. Configure:

   ```ts
   google: {
     // …
     pubsub: {
       audience: 'https://api.example.com/webhooks/google',
       serviceAccountEmail: 'pubsub-push@<project>.iam.gserviceaccount.com',
     },
   }
   ```

The handler checks the OIDC token's RS256 signature against Google's JWKS, its issuer,
audience, expiry (60 s skew) and, if configured, its `email` / `email_verified`. JWKS are cached
for `Cache-Control: max-age` (default 1 h). An unknown `kid` triggers at most one refetch
every 60 s.

If you can't use OIDC, set `pubsub.verificationToken` to a long random string and use
`https://api.example.com/webhooks/google?token=<it>` as the push endpoint. The token is
compared in constant time.

## PurchaseStore: SQL recipe

`MemoryPurchaseStore` is for tests and prototypes. In production, implement the
`PurchaseStore` interface on your database. The guarantees that matter:

- `(platform, key)` is unique, so only one record per purchase can be inserted.
- `(platform, token)` is unique across records, so a Google token can't join two chains.
- `replace` is a compare-and-set on `version`.
- `rememberNotification` is an insert into a unique `(platform, notification_id)`.

```sql
-- PostgreSQL
create table iap_purchases (
  platform      text        not null,
  key           text        not null,
  user_id       text,                      -- null = not claimed / released
  purchase      jsonb       not null,      -- serializePurchase(purchase)
  product_id    text        not null,      -- promoted for querying/reporting
  status        text        not null,
  expires_at    timestamptz,
  last_event_at timestamptz not null,
  claimed_at    timestamptz,               -- first successful claim; never cleared
  version       integer     not null,
  created_at    timestamptz not null,
  updated_at    timestamptz not null,
  primary key (platform, key)
);
create index iap_purchases_user_id on iap_purchases (user_id);

create table iap_purchase_tokens (
  platform text not null,
  token    text not null,
  key      text not null,
  primary key (platform, token),
  foreign key (platform, key) references iap_purchases (platform, key) on delete cascade
);

create table iap_notifications (
  platform        text        not null,
  notification_id text        not null,
  created_at      timestamptz not null default now(),
  primary key (platform, notification_id)
);
```

```ts
import type { Pool, PoolClient } from 'pg';
import {
  deserializePurchase,
  serializePurchase,
  type PurchaseRecord,
  type PurchaseStore,
} from '@bijayx/iap-guard';

export class PgPurchaseStore implements PurchaseStore {
  constructor(private readonly pool: Pool) {}

  async insert(r: PurchaseRecord): Promise<boolean> {
    return this.tx(async (db) => {
      const inserted = await db.query(
        `insert into iap_purchases (platform, key, user_id, purchase, product_id, status, expires_at,
                                    last_event_at, version, created_at, updated_at, claimed_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict do nothing`,
        [
          r.platform,
          r.key,
          r.userId,
          serializePurchase(r.purchase),
          r.purchase.productId,
          r.purchase.status,
          r.purchase.expiresAt,
          r.lastEventAt,
          r.version,
          r.createdAt,
          r.updatedAt,
          r.claimedAt,
        ],
      );
      return inserted.rowCount === 1 && (await this.addTokens(db, r));
    });
  }

  async replace(r: PurchaseRecord, expectedVersion: number): Promise<boolean> {
    return this.tx(async (db) => {
      const updated = await db.query(
        `update iap_purchases set user_id = $3, purchase = $4, product_id = $5, status = $6, expires_at = $7,
                last_event_at = $8, version = $9, updated_at = $10, claimed_at = $12
          where platform = $1 and key = $2 and version = $11`,
        [
          r.platform,
          r.key,
          r.userId,
          serializePurchase(r.purchase),
          r.purchase.productId,
          r.purchase.status,
          r.purchase.expiresAt,
          r.lastEventAt,
          r.version,
          r.updatedAt,
          expectedVersion,
          r.claimedAt,
        ],
      );
      return updated.rowCount === 1 && (await this.addTokens(db, r));
    });
  }

  async rememberNotification(platform: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `insert into iap_notifications (platform, notification_id) values ($1, $2) on conflict do nothing`,
      [platform, id],
    );
    return res.rowCount === 1;
  }

  async forgetNotification(platform: string, id: string): Promise<void> {
    await this.pool.query(
      `delete from iap_notifications where platform = $1 and notification_id = $2`,
      [platform, id],
    );
  }

  async findByKey(platform: string, key: string) {
    return this.one(`select * from iap_purchases where platform = $1 and key = $2`, [
      platform,
      key,
    ]);
  }

  async findByToken(platform: string, token: string) {
    return this.one(
      `select p.* from iap_purchases p join iap_purchase_tokens t using (platform, key)
        where t.platform = $1 and t.token = $2`,
      [platform, token],
    );
  }

  async findByUser(userId: string) {
    const { rows } = await this.pool.query(`select * from iap_purchases where user_id = $1`, [
      userId,
    ]);
    return Promise.all(rows.map((row) => this.toRecord(row)));
  }

  /** Adds new tokens; false (→ rollback) if a token already belongs to another record. */
  private async addTokens(db: PoolClient, r: PurchaseRecord): Promise<boolean> {
    for (const token of r.tokens) {
      await db.query(
        `insert into iap_purchase_tokens (platform, token, key) values ($1, $2, $3) on conflict do nothing`,
        [r.platform, token, r.key],
      );
    }
    const { rows } = await db.query(
      `select 1 from iap_purchase_tokens where platform = $1 and token = any($2) and key <> $3`,
      [r.platform, r.tokens, r.key],
    );
    return rows.length === 0;
  }

  private async tx(work: (db: PoolClient) => Promise<boolean>): Promise<boolean> {
    const db = await this.pool.connect();
    try {
      await db.query('begin');
      const ok = await work(db);
      await db.query(ok ? 'commit' : 'rollback');
      return ok;
    } catch (error) {
      await db.query('rollback');
      throw error;
    } finally {
      db.release();
    }
  }

  private async one(sql: string, params: unknown[]) {
    const { rows } = await this.pool.query(sql, params);
    return rows[0] ? this.toRecord(rows[0]) : null;
  }

  private async toRecord(row: any): Promise<PurchaseRecord> {
    const { rows } = await this.pool.query(
      `select token from iap_purchase_tokens where platform = $1 and key = $2`,
      [row.platform, row.key],
    );
    return {
      platform: row.platform,
      key: row.key,
      userId: row.user_id,
      purchase: deserializePurchase(row.purchase),
      tokens: rows.map((t) => t.token),
      lastEventAt: row.last_event_at,
      claimedAt: row.claimed_at,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
```

This recipe isn't shipped or tested in this package. Adapt it to your database and
migrations. The Laravel package ships an equivalent `DatabasePurchaseStore`.

## Testing with sandbox accounts

**Apple**

- Create a **Sandbox Apple Account** in App Store Connect → Users and Access → Sandbox. On
  the device, sign in under **Settings → Developer → Sandbox Apple Account**. TestFlight
  builds use sandbox too.
- Sandbox purchases verify like production ones but have `environment: 'sandbox'`. They are
  allowed by default, which App Review needs.
- Sandbox subscriptions renew on an accelerated schedule (minutes instead of months), which
  is useful for testing `DID_RENEW` / `EXPIRED` notifications against your sandbox URL.
- **Xcode StoreKit Testing** (`.storekit` configuration files) and `LocalTesting` transactions
  are signed by Xcode, not Apple, so they always fail with `INVALID_SIGNATURE`. Test the
  server with sandbox purchases, and test UI flows with Xcode.

**Google**

- Add tester accounts under **Play Console → Settings → License testing**, and install the app
  from an internal testing track. Their purchases use test payment methods and come back with
  `environment: 'sandbox'`.
- The **"Slow test card, approves/declines after a few minutes"** produces a pending purchase.
  Use it for edge case 13: `status: 'pending'` until the RTDN activates it.
- Test subscriptions renew on an accelerated schedule; RTDNs fire for each event.
- Set `allowTestPurchases: false` on servers that must reject tester purchases.

**Unit tests in your app**

Inject `clock` and `http.fetch`, and use `MemoryPurchaseStore`. This package's own suite runs
offline against signed fixtures: a test certificate chain trusted via `rootCertificates`, fake
App Store and Play responses, Pub/Sub OIDC tokens, and RTDN bodies. All of them are in
`tests/fixtures`.

## Limitations

- **No certificate revocation checks (OCSP/CRL).** The Apple chain is verified offline at the
  JWS `signedDate`, like Apple's own library with online checks disabled.
- **No StoreKit 1 receipts.** The deprecated `verifyReceipt` endpoint and app receipts aren't
  supported. Use StoreKit 2 (`jwsRepresentation`), or send a `transactionId` with `apple.api`
  configured.
- **Not covered:** Google `purchases.subscriptions.get` (v1), Apple's Advanced Commerce API,
  external purchase tokens (their notifications are verified and return `purchase: null`),
  Apple notification history / Google voided-purchases backfill, and App Store promotional
  offer signing.
- Google subscription chains are linked one step at a time through `linkedPurchaseToken`. If a
  token in the middle of a chain was never seen (no claim, no notification), the next token
  starts a new record.
- Notifications store state for any product, environment-allowed test purchase or family-shared
  purchase. The allowlist, `allowTestPurchases` and `allowFamilySharing` are enforced on
  `verify` / `claim`.
- `MemoryPurchaseStore` is single-process and not durable.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Bijay Shrestha
