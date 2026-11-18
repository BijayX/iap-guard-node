# iap-guard — shared specification

Server-side verification **and ownership protection** for Apple App Store and Google Play
in-app purchases. Two packages implement this contract:

- `@bijayx/iap-guard` (Node.js, TypeScript, zero runtime dependencies)
- `bijayx/iap-guard-laravel` (Laravel 12/13, PHP 8.3+)

Names are camelCase (Node); PHP uses the same camelCase methods/properties and `snake_case`
config keys / DB columns. Enum string values are identical in both packages.

Sources (checked 2026-11-18):

- Apple: App Store Server API, App Store Server Notifications V2, and Apple's official
  `app-store-server-library-node` (`jws_verification.ts`, `models/*`).
- Google: Android Publisher API v3 discovery document (`purchases.subscriptionsv2`,
  `purchases.productsv2`, `purchases.products`, `purchases.subscriptions`), and the RTDN reference
  https://developer.android.com/google/play/billing/rtdn-reference.

Not supported (deprecated or out of scope): Apple `verifyReceipt` / StoreKit 1 receipts, Google
`purchases.subscriptions.get` (v1), Advanced Commerce API, external purchase tokens.

---

## 1. Layers

```
verify()          stateless: proves a purchase is genuine and normalizes it      (§5, §6)
claim()           verify + ownership rules + persistence + acknowledge/consume  (§7)
handle*Notification()  verify webhook + dedupe + refresh state + persist       (§8)
entitlements()    what a user may access right now, across platforms/devices    (§7.6)
```

`verify` is usable without a store. Everything else requires a `PurchaseStore` (§9).

## 2. Core rule: entitlements belong to YOUR user, not to a device or store account

- Clients never decide access. A device sends **proof** (Apple signed transaction / transaction
  id, Google purchase token); the server verifies it with Apple/Google and records it against the
  authenticated app user (`userId`, always a string).
- Every purchase has an **ownership key** that stays the same across renewals, plan changes,
  restores and devices:

| platform | product type                                                | ownership key                                                                        |
| -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| apple    | auto-renewable subscription, non-consumable, non-renewing   | `originalTransactionId`                                                              |
| apple    | consumable                                                  | `transactionId`                                                                      |
| google   | subscription                                                | the **first** purchase token of the chain (follow `linkedPurchaseToken`, §6.4)       |
| google   | one-time product (consumable or not)                        | `purchaseToken`                                                                      |

- A key has **at most one owner**. Whoever owns it gets the entitlement on every device they sign in to,
  on both platforms.

## 3. Shared types

```
Platform            = "apple" | "google"
ProductType         = "subscription" | "non_consumable" | "consumable" | "non_renewing_subscription"
Environment         = "production" | "sandbox"           // Apple Sandbox and Google test purchases → "sandbox"
PurchaseStatus      = "pending" | "active" | "grace_period" | "billing_retry" | "paused"
                    | "expired" | "revoked" | "canceled"
Ownership           = "created" | "existing" | "transferred"
ConflictPolicy      = "reject" | "transfer"
NotificationEvent   = "purchased" | "renewed" | "recovered" | "renewal_failed" | "grace_period_started"
                    | "auto_renew_enabled" | "auto_renew_disabled" | "plan_changed" | "expired"
                    | "refunded" | "revoked" | "refund_reversed" | "paused" | "canceled"
                    | "price_change" | "consumption_request" | "test" | "other"
```

### Purchase (normalized, immutable)

| field                  | type            | notes                                                                                     |
| ---------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| platform               | Platform        |                                                                                           |
| key                    | string          | ownership key (§2)                                                                        |
| productId              | string          | Apple `productId`; Google first line item's productId                                     |
| productIds             | string[]        | all products (Google bundles can have several line items); Apple: `[productId]`           |
| type                   | ProductType     |                                                                                           |
| status                 | PurchaseStatus  | as of `signedAt` (§4)                                                                     |
| environment            | Environment     |                                                                                           |
| transactionId          | string          | Apple `transactionId` (latest); Google `orderId` (latest; `latestSuccessfulOrderId` for subs) — may be `""` for pending Google purchases |
| originalTransactionId  | string \| null  | Apple only                                                                                |
| purchaseToken          | string \| null  | Google only: the **current** token                                                        |
| linkedPurchaseToken    | string \| null  | Google subscriptions only                                                                 |
| purchasedAt            | Date            | Apple `purchaseDate`; Google sub `startTime`, product `purchaseCompletionTime` (fallback: fetch time) |
| expiresAt              | Date \| null    | subscriptions; Google = max `expiryTime` of line items                                    |
| gracePeriodExpiresAt   | Date \| null    | Apple `renewalInfo.gracePeriodExpiresDate`; Google: `null`                                |
| willRenew              | boolean \| null | Apple `renewalInfo.autoRenewStatus === 1`; Google `autoRenewingPlan.autoRenewEnabled`; null for non-subscriptions or when unknown |
| autoRenewProductId     | string \| null  | Apple `renewalInfo.autoRenewProductId` (pending downgrade); Google null                   |
| accountToken           | string \| null  | Apple `appAccountToken`; Google `externalAccountIdentifiers.obfuscatedExternalAccountId` / `obfuscatedExternalAccountId` |
| quantity               | int             | default 1                                                                                 |
| familyShared           | boolean         | Apple `inAppOwnershipType === "FAMILY_SHARED"`                                            |
| acknowledged           | boolean \| null | Google `acknowledgementState`; Apple null                                                 |
| revokedAt              | Date \| null    | Apple `revocationDate`; Google: time we processed a voided-purchase notification          |
| signedAt               | Date            | when this state was produced: Apple JWS `signedDate`; Google = our clock at fetch time   |
| raw                    | object          | decoded store payload(s) — never contains our secrets                                     |

`isEntitled(purchase, now)`:

```
status == "active"        → expiresAt == null || expiresAt > now
status == "grace_period"  → (gracePeriodExpiresAt ?? expiresAt) == null || (gracePeriodExpiresAt ?? expiresAt) > now
anything else             → false
```

(Time-based so a stored "active" subscription stops granting access at `expiresAt` even if a webhook is missed.)

## 4. Status mapping

### Apple

1. `revocationDate` present → `revoked` (covers refunds, `FAMILY_REVOKE`, `ASSIGNMENT_REVOKE`).
2. `type` Consumable / Non-Consumable / Non-Renewing Subscription → `active`.
3. Auto-renewable with a known numeric status (notification `data.status` or Server API
   `lastTransactions[].status`): `1 active`, `2 expired`, `3 billing_retry`, `4 grace_period`, `5 revoked`.
4. Otherwise compute at `signedAt`: `expiresDate > signedAt` → `active`; else
   `renewalInfo.gracePeriodExpiresDate > signedAt` → `grace_period`; else
   `renewalInfo.isInBillingRetryPeriod === true` → `billing_retry`; else `expired`.

Type mapping: `"Auto-Renewable Subscription"` → subscription, `"Non-Consumable"` → non_consumable,
`"Consumable"` → consumable, `"Non-Renewing Subscription"` → non_renewing_subscription.

### Google subscriptions (`subscriptionsv2`)

| subscriptionState                              | status                                                      |
| ---------------------------------------------- | ----------------------------------------------------------- |
| SUBSCRIPTION_STATE_PENDING                     | pending                                                     |
| SUBSCRIPTION_STATE_ACTIVE                      | active                                                      |
| SUBSCRIPTION_STATE_IN_GRACE_PERIOD             | grace_period                                                |
| SUBSCRIPTION_STATE_ON_HOLD                     | billing_retry                                               |
| SUBSCRIPTION_STATE_PAUSED                      | paused                                                      |
| SUBSCRIPTION_STATE_CANCELED                    | `active` if `expiresAt > signedAt` else `expired` (canceled = won't renew; access continues until expiry). `willRenew = false` |
| SUBSCRIPTION_STATE_EXPIRED                     | expired                                                     |
| SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED   | canceled                                                    |
| anything else                                  | expired (fail closed)                                       |

Google subscription fields: `willRenew` = first line item `autoRenewingPlan` → `autoRenewEnabled === true`;
`prepaidPlan` → `false`; neither → `null`; state CANCELED → always `false`.

Google one-time products (`productsv2`), `purchaseStateContext.purchaseState`:
`PURCHASED` → active, `PENDING` → pending, `CANCELLED` → canceled, anything else → canceled (fail closed).
Type: `consumable` if productId is in `google.consumableProductIds`, else `non_consumable`.
Environment: `testPurchase` (subs) / `testPurchaseContext` (products) present → `sandbox`.
One-time `quantity` = `productLineItem[0].productOfferDetails.quantity ?? 1`; `transactionId` = `orderId ?? ""`.
The fixtures' `expected` objects are the reference output of these rules — when prose and fixtures disagree, fix the prose.

## 5. Apple

### 5.1 Config

| key                  | required | default                          | notes                                                       |
| -------------------- | -------- | -------------------------------- | ----------------------------------------------------------- |
| bundleId             | yes      |                                  |                                                             |
| appAppleId           | prod     | null                             | numeric App Store app id; **required when production environment is allowed** (checked on notifications, like Apple's library) |
| environments         | no       | `["production","sandbox"]`       | App Review tests your production server with **sandbox** purchases — keep sandbox allowed and use `purchase.environment` to separate revenue. |
| allowFamilySharing   | no       | true                             | false → `FAMILY_SHARING_NOT_ALLOWED`                          |
| rootCertificates     | no       | bundled Apple Root CA - G3       | DER or PEM; tests inject `fixtures/apple/certs/root.pem`     |
| api                  | no       | null                             | `{ issuerId, keyId, privateKey (PKCS#8 PEM, .p8) }` enables the App Store Server API |
| api.baseUrls         | no       | prod `https://api.storekit.itunes.apple.com`, sandbox `https://api.storekit-sandbox.itunes.apple.com` | override for tests/proxies |

Bundled root: Apple Root CA - G3, SHA-256 fingerprint
`63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79`
(from https://www.apple.com/certificateauthority/AppleRootCA-G3.cer, expires 2039-04-30). Both packages ship it as `AppleRootCA-G3.pem`.

### 5.2 JWS verification (transactions, renewal info, notifications)

Implemented with platform crypto only (Node `node:crypto`, PHP `ext-openssl`). Steps, all must pass
or `VerificationError(INVALID_SIGNATURE)`:

1. Exactly three dot-separated base64url segments; header and payload are JSON objects.
2. Header `alg === "ES256"`; `x5c` is an array of **exactly 3** base64 (standard, not url) DER certs.
3. Trust anchor: `x5c[1]` (intermediate) must be signed by one of the configured root certificates and
   its issuer must equal that root's subject. `x5c[2]` is ignored (never trusted from the token).
4. `x5c[0]` (leaf) is signed by the intermediate and its issuer equals the intermediate's subject.
5. Intermediate is a CA (basicConstraints CA:TRUE).
6. Leaf has extension OID `1.2.840.113635.100.6.11.1`; intermediate has `1.2.840.113635.100.6.2.1`.
7. Leaf, intermediate and root are all valid (notBefore ≤ date ≤ notAfter) at the **effective date** =
   payload `signedDate` (ms). Missing/non-numeric `signedDate` → INVALID_SIGNATURE.
   Also reject `signedDate > now + 60s` (clock skew).
8. ES256 signature over `header.payload` (ASCII) with the leaf public key. JWS signatures are raw `r||s`
   (64 bytes); PHP must convert to DER for `openssl_verify`. Reject signatures that aren't 64 bytes.

No OCSP (same as Apple's library with online checks disabled); documented in README.
Unsigned/Xcode/LocalTesting transactions therefore always fail (they are not Apple-signed).

After the signature:

- `bundleId` must equal config → `VerificationError(WRONG_APP)`.
- environment (`"Production"` → production, `"Sandbox"` → sandbox, anything else → INVALID_SIGNATURE)
  must be in `environments` → `PolicyError(ENVIRONMENT_NOT_ALLOWED)`.
- For notifications additionally: when the environment is production and `appAppleId` is configured,
  `data.appAppleId` must equal it → WRONG_APP.

### 5.3 App Store Server API (optional, `api` configured)

Auth: JWT per request (cache ≤ 5 min, regenerate before expiry), header
`{"alg":"ES256","kid":keyId,"typ":"JWT"}`, payload
`{"iss":issuerId,"iat":now,"exp":now+300,"aud":"appstoreconnect-v1","bid":bundleId}`, signed raw r||s, base64url.
Header `Authorization: Bearer <jwt>`.

Endpoints (base chosen by environment):

- `GET /inApps/v1/transactions/{transactionId}` → `{ signedTransactionInfo }`
- `GET /inApps/v1/subscriptions/{transactionId}` → `{ environment, bundleId, appAppleId, data: [{ subscriptionGroupIdentifier, lastTransactions: [{ originalTransactionId, status, signedTransactionInfo, signedRenewalInfo }] }] }`

Every `signed*` value from the API is verified with §5.2 exactly like client input (defense in depth).

Errors: 401 → `AuthenticationError`; 404 with `errorCode` 4040010 (transaction id not found) →
`PurchaseNotFoundError` (but see fallback); 429 / 5xx → `StoreApiError` retryable (GET only, honor
`Retry-After` seconds when ≤ 10); other 4xx → `StoreApiError` not retryable. Error body shape:
`{ "errorCode": 4040010, "errorMessage": "Transaction id not found." }`.

Environment fallback for `verify({transactionId})`: call production first (if allowed); on 4040010 call
sandbox (if allowed). (Apple's documented approach.)

### 5.4 verify (apple)

Input (exactly one of):

- `{ platform: "apple", signedTransaction: string }` — StoreKit 2 `Transaction.jwsRepresentation` (**preferred**, works offline)
- `{ platform: "apple", transactionId: string }` — requires `api`, else `ConfigurationError`

Steps:

1. Obtain and verify the signed transaction (§5.2).
2. If the product is an auto-renewable subscription **and** `api` is configured: call
   `GET /inApps/v1/subscriptions/{transactionId}` (environment of the transaction), find the
   `lastTransactions` item whose `originalTransactionId` matches; verify its `signedTransactionInfo` and
   `signedRenewalInfo`; build the Purchase from those (latest state) and the numeric `status`.
   If not found there, fall back to the client transaction.
   Without `api`, the Purchase is built from the client transaction alone (status computed per §4 rule 4,
   `willRenew = null`).
3. `familyShared && !allowFamilySharing` → `PolicyError(FAMILY_SHARING_NOT_ALLOWED)`.
4. Product allowlist (§7.1) → `PolicyError(UNKNOWN_PRODUCT)`.

`signedAt` = max(`signedDate` of the transaction and renewal info used).

## 6. Google Play

### 6.1 Config

| key                    | required | default | notes                                                                    |
| ---------------------- | -------- | ------- | ------------------------------------------------------------------------ |
| packageName            | yes      |         |                                                                          |
| serviceAccount         | yes      |         | JSON string or object `{ client_email, private_key, token_uri? }` (Laravel also accepts a file path) |
| consumableProductIds   | no       | `[]`    | Play doesn't say which products are consumable; we consume these after claim |
| allowTestPurchases     | no       | true    | false → `PolicyError(ENVIRONMENT_NOT_ALLOWED)` for license-tester purchases |
| pubsub.audience        | one of   |         | verify Pub/Sub push OIDC JWT (recommended)                                |
| pubsub.serviceAccountEmail | no   | null    | when set, the OIDC `email` claim must equal it                           |
| pubsub.verificationToken | one of |         | shared secret expected as `?token=` on the push URL (simpler, weaker)   |
| baseUrl                | no       | `https://androidpublisher.googleapis.com/androidpublisher/v3/` | tests |
| tokenUrl               | no       | `serviceAccount.token_uri` ?? `https://oauth2.googleapis.com/token` |      |
| jwksUrl                | no       | `https://www.googleapis.com/oauth2/v3/certs` | Google OIDC signing keys       |

Notification handling requires `pubsub.audience` or `pubsub.verificationToken` (else `ConfigurationError`
when `handleGoogleNotification` is called).

### 6.2 OAuth (service account)

JWT RS256: header `{"alg":"RS256","typ":"JWT"}`, payload
`{"iss":client_email,"scope":"https://www.googleapis.com/auth/androidpublisher","aud":tokenUrl,"iat":now,"exp":now+3600}`.
`POST tokenUrl` form `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>` →
`{ access_token, expires_in, token_type }`. Cache until `expires_in - 60s`. Concurrent callers share one
in-flight request (Node: shared promise; Laravel: cache store). Token endpoint 400/401 → `AuthenticationError`
(never include the private key or assertion in errors).

### 6.3 Endpoints (relative to baseUrl, path segments URL-encoded)

- `GET  applications/{pkg}/purchases/subscriptionsv2/tokens/{token}`
- `GET  applications/{pkg}/purchases/productsv2/tokens/{token}`
- `POST applications/{pkg}/purchases/subscriptions/{productId}/tokens/{token}:acknowledge` (body `{}`)
- `POST applications/{pkg}/purchases/products/{productId}/tokens/{token}:acknowledge` (body `{}`)
- `POST applications/{pkg}/purchases/products/{productId}/tokens/{token}:consume`

Errors: 401/403 → `AuthenticationError`; 400, 404 or 410 → `PurchaseNotFoundError` (400 = malformed token — our
requests are otherwise well-formed; 410 = token expired >60 days ago);
429/5xx → `StoreApiError` retryable (GETs retried; POSTs are retried too because acknowledge/consume are idempotent).
Google error body: `{ "error": { "code": 404, "message": "...", "status": "NOT_FOUND" } }`.

### 6.4 verify (google)

Input: `{ platform: "google", type: "subscription" | "one_time", purchaseToken: string, productId?: string }`.

1. Fetch `subscriptionsv2` or `productsv2`.
2. If `productId` given and not in the purchase's productIds → `VerificationError(PRODUCT_MISMATCH)`.
3. Test purchase and `!allowTestPurchases` → `PolicyError(ENVIRONMENT_NOT_ALLOWED)`.
4. Product allowlist (§7.1).
5. Normalize. `key` for subscriptions is the token itself at this stage; `claim` resolves the chain root (§7.3).

There is no packageName in Google responses: the package is enforced by the URL we call.

## 7. claim — ownership rules

### 7.1 Config (`ownership` / top-level)

| key                     | default    | notes                                                                                     |
| ----------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| conflictPolicy          | `"reject"` | what to do when another user already owns the purchase (§7.4)                              |
| accountTokenSecret      | null       | enables `accountTokenFor(userId)` and account-token binding checks (§7.5); ≥ 32 chars      |
| products                | null       | optional allowlist of product ids (both platforms); unknown → `PolicyError(UNKNOWN_PRODUCT)` |

### 7.2 Input / output

```
claim({ userId: string, ...verifyInput })  →  ClaimResult
ClaimResult {
  purchase: Purchase            // the stored (possibly newer than the input) state
  isEntitled: boolean           // isEntitled(purchase, now)
  isNew: boolean                // true only the first time this transaction/token is recorded for ANY user
                                // → grant consumables ONLY when true (replays return false)
  ownership: Ownership          // "created" | "existing" | "transferred"
  previousUserId: string|null   // set when ownership === "transferred" → revoke access for that user
  otherActive: Purchase[]       // this user's OTHER entitled purchases (e.g. already subscribed on the other platform)
}
```

`userId` must be a non-empty string ≤ 191 chars (else ValidationError).

### 7.3 Algorithm

```
1. purchase = verify(input)                                      // throws on anything not genuine
2. key = purchase.key
   google subscription: if purchase.linkedPurchaseToken and store.findByToken(google, linked) → key = that record.key
                        else if store.findByToken(google, purchase.purchaseToken) → key = that record.key
3. account-token check (§7.5) → may throw OwnershipError(ACCOUNT_MISMATCH) (policy "reject")
4. loop (max 3 attempts, then IapError CONCURRENT_MODIFICATION):
     record = store.findByKey(platform, key)
     if record is null:
         insert new record { userId, purchase, tokens: [purchaseToken?, linked?], claimedAt: now, version: 1 }
         if insert returned false (another device won the race) → continue loop
         ownership = "created"; isNew = true
     else:
         isNew = record.claimedAt is null (stored by a webhook, never claimed — e.g. ONE_TIME_CHARGE / RTDN before the app called claim)
                 OR record has never seen this transaction:
                 apple: record.purchase.transactionId != purchase.transactionId AND purchase.signedAt > record.lastEventAt
                 google: purchase.purchaseToken not in record.tokens
         if record.userId is null or == userId → ownership = record.userId ? "existing" : "created"
         else (owned by someone else) → conflictPolicy:
             "reject"   → throw OwnershipError(ALREADY_OWNED)   // message never reveals the other user
             "transfer" → ownership = "transferred"; previousUserId = record.userId
         superseded = google && purchase.purchaseToken in record.tokens && purchase.purchaseToken != record.purchase.purchaseToken
                      // an older token of the chain: Play reports it canceled/expired after an upgrade
         newer = !superseded && purchase.signedAt >= record.lastEventAt   // stale proofs never roll state back
         next = { ...record, userId, claimedAt: record.claimedAt ?? now, purchase: newer ? purchase : record.purchase,
                  lastEventAt: max(...), tokens: record.tokens ∪ {purchaseToken, linked}, version: record.version + 1 }
         if not store.replace(next, record.version) → continue loop   // optimistic concurrency
5. acknowledge/consume (google, §7.7)
6. otherActive = store.findByUser(userId) entitled, excluding this key
7. return ClaimResult
```

Consumables: key is per transaction/token, so every consumable purchase is its own record. A replay of the
same token/transaction → `isNew = false` → the app must not grant again.

### 7.4 Edge cases this covers (document in README with these exact scenarios)

| # | scenario | result |
|---|----------|--------|
| 1 | Same user, second device (iPad after iPhone, or reinstall) restores | `existing`, `isNew=false`, entitled |
| 2 | Same user, subscribed on iOS, opens the Android app | no Google purchase needed: `entitlements(userId)` already includes the Apple subscription |
| 3 | Two app accounts on one phone with one Apple ID / Google account: B restores A's purchase | `reject` (default) → `ALREADY_OWNED`; `transfer` → B owns it, `previousUserId = A` |
| 4 | Same as 3 but the purchase carries A's account token | `ACCOUNT_MISMATCH` (reject) / transfer (transfer policy) — see §7.5 |
| 5 | Two devices of the same user claim at the same moment | atomic insert + versioned replace; one creates, the other sees `existing`; never two owners |
| 6 | Client replays an old consumable proof | `isNew=false` → no double grant |
| 7 | Client sends an old (stale) subscription JWS after a newer one | ownership checks run, but stored state is not rolled back |
| 8 | Google upgrade/downgrade/resubscribe creates a new token with `linkedPurchaseToken` | new token joins the existing chain (same key, same owner); the old token can't be claimed by anyone else |
| 9 | Apple upgrade/downgrade within a subscription group | same `originalTransactionId` → same record |
| 10 | Apple Family Sharing | each family member's transaction has its own `originalTransactionId`; `familyShared=true`; disable with `allowFamilySharing=false` |
| 11 | Webhook arrives before the app claims | record stored with `userId = null`; first claim by a matching user takes it (`created`) |
| 12 | User subscribes on both platforms | both recorded; `otherActive` on the second claim lets the app warn about double billing |
| 13 | Pending purchase (Google "slow card", Ask to Buy) | recorded, `status=pending`, not entitled, **not acknowledged**; a later notification activates it |
| 14 | Refund / revoke | notification sets `revoked`; entitlement ends; event lets the app claw back consumables |
| 15 | Account deleted | `releaseUser(userId)` sets `userId=null` on that user's records so the store account can be restored into a new app account |
| 16 | Sandbox purchase on production server (App Review) | allowed by default, `environment="sandbox"` |
| 17 | Purchase for another app (bundle/package) | `WRONG_APP` |
| 18 | Forged/tampered/self-signed JWS, Xcode/StoreKit-testing transaction | `INVALID_SIGNATURE` |

### 7.5 Account tokens (binding a store purchase to your user at purchase time)

`accountTokenFor(userId)`: deterministic UUID derived from `HMAC-SHA256(accountTokenSecret, "iap-guard:" + userId)`:
take the first 16 bytes, set `byte[6] = (byte[6] & 0x0f) | 0x80` (version 8, custom) and
`byte[8] = (byte[8] & 0x3f) | 0x80` (RFC 4122 variant), format lowercase `8-4-4-4-12`.
Fixture: `fixtures/account-tokens.json`.

The app passes it to the purchase call: StoreKit 2 `.appAccountToken(UUID(uuidString: token))`, Play Billing
`BillingFlowParams.setObfuscatedAccountId(token)`. The secret never leaves the server; the token reveals nothing
about the user id and can't be forged for another user.

Check in claim (only when `accountTokenSecret` is configured **and** `purchase.accountToken` is non-null):
`purchase.accountToken` is compared case-insensitively with `accountTokenFor(userId)`; mismatch → under `reject`
throw `OwnershipError(ACCOUNT_MISMATCH)`, under `transfer` continue (normal ownership rules then apply).
Purchases without a token (older app versions) skip this check.

### 7.6 entitlements / helpers

- `entitlements(userId, now?)` → `Purchase[]` of the user's records where `isEntitled`; sorted by `expiresAt` desc (null first).
- `isEntitled(purchase, now?)` (§3).
- `releaseUser(userId)` → number of records released (set `userId=null`, versioned replace).

### 7.7 Google acknowledge / consume (after the record is stored and owned)

- Only when `purchase.status` is `active` or `grace_period` **and** the record has an owner.
- consumable (`consumableProductIds`) → `:consume` (consumption implies acknowledgement); else if
  `acknowledged === false` → `:acknowledge` (subscriptions use `purchases/subscriptions/{productId}`).
- On success update the stored purchase `acknowledged = true` (best effort, versioned replace; a failed replace is ignored).
- If acknowledge/consume fails, **the claim still succeeds** (state is stored); the error is logged and
  `ClaimResult.purchase.acknowledged` stays false. A later claim or notification retries.
  Rationale: Play auto-refunds purchases not acknowledged within 3 days — retrying is safe and idempotent.

## 8. Notifications (webhooks)

```
NotificationResult {
  platform, id: string,                       // Apple notificationUUID; Google Pub/Sub message.messageId
  event: NotificationEvent, rawType: string,  // e.g. "DID_RENEW/BILLING_RECOVERY", "SUBSCRIPTION_RENEWED"
  duplicate: boolean,                         // already processed → nothing else done, purchase null
  stale: boolean,                             // older than stored state → stored state kept
  purchase: Purchase|null,                    // stored state after processing (null for test/duplicate/unknown)
  userId: string|null,                        // current owner (null when not claimed yet)
  raw: object
}
```

Processing order: authenticate → parse → dedupe (`store.rememberNotification(platform, id)`, false → duplicate) →
refresh state → upsert record (never change `userId`, never roll back: only write when `purchase.signedAt >= record.lastEventAt`
and the purchase is not a superseded Google token (§7.3), else `stale=true`) → Google acknowledge if owned (§7.7) → return.

If processing throws after `rememberNotification`, call `store.forgetNotification(platform, id)` before rethrowing,
so the store's retry is not treated as a duplicate. HTTP layer returns 200 for success/duplicate/stale,
400 for authentication/verification errors (Apple/Google will retry 5xx; a forged request should not be retried),
500 for store/network errors (so the platform retries).

### 8.1 Apple (App Store Server Notifications V2)

Body: JSON `{ "signedPayload": "<JWS>" }` (missing/not JSON → `VerificationError(INVALID_NOTIFICATION)`).
Verify the JWS (§5.2) incl. bundleId/environment/appAppleId checks from `data`. `version` must be `"2.0"`.
For notifications with `data.signedTransactionInfo`: verify it (and `signedRenewalInfo` when present), build the
Purchase with `status = data.status` when present, `signedAt = notification signedDate`.
Notifications without transaction data (TEST, summary, external purchase tokens) → `purchase: null`.

| notificationType / subtype                     | event                  |
| ---------------------------------------------- | ---------------------- |
| SUBSCRIBED (any)                               | purchased              |
| ONE_TIME_CHARGE                                | purchased              |
| DID_RENEW / BILLING_RECOVERY                   | recovered              |
| DID_RENEW (other)                              | renewed                |
| DID_FAIL_TO_RENEW / GRACE_PERIOD               | grace_period_started   |
| DID_FAIL_TO_RENEW (other)                      | renewal_failed         |
| DID_CHANGE_RENEWAL_STATUS / AUTO_RENEW_ENABLED | auto_renew_enabled     |
| DID_CHANGE_RENEWAL_STATUS / AUTO_RENEW_DISABLED| auto_renew_disabled    |
| DID_CHANGE_RENEWAL_PREF                        | plan_changed           |
| EXPIRED, GRACE_PERIOD_EXPIRED                  | expired                |
| REFUND                                         | refunded               |
| REVOKE                                         | revoked                |
| REFUND_REVERSED                                | refund_reversed        |
| PRICE_INCREASE, PRICE_CHANGE                   | price_change           |
| CONSUMPTION_REQUEST                            | consumption_request    |
| TEST                                           | test                   |
| anything else                                  | other                  |

`rawType` = `notificationType` + (`"/" + subtype` when subtype present).

Upsert key: consumable → `transactionId`, else `originalTransactionId`.

### 8.2 Google (RTDN via Pub/Sub push)

Authentication (before parsing):

- `pubsub.audience` set: header `Authorization: Bearer <JWT>`; RS256 only; `kid` must be in Google JWKS
  (fetched from `jwksUrl`, cached for `Cache-Control: max-age` seconds or 1h; on unknown `kid` refetch once);
  `iss ∈ {"accounts.google.com","https://accounts.google.com"}`; `aud === audience`; `exp > now - 60s`;
  `iat <= now + 60s`; if `serviceAccountEmail` set: `email === serviceAccountEmail && email_verified === true`.
  Any failure → `VerificationError(INVALID_SIGNATURE)`.
- else `pubsub.verificationToken`: query `token` must equal it (constant-time) → else INVALID_SIGNATURE.

Body `{ message: { data: base64, messageId, publishTime, attributes? }, subscription }`; bad shape or data not
base64 JSON → INVALID_NOTIFICATION. `packageName` must equal config → WRONG_APP. `eventTimeMillis` may be a string.

**Never trust notification content beyond the token**: always fetch current state from the API (§6.3).

| payload                                          | action                                   | event |
| ------------------------------------------------ | ---------------------------------------- | ----- |
| `testNotification`                               | none                                     | test |
| `subscriptionNotification` type 1 RECOVERED     | fetch subscriptionsv2                    | recovered |
| 2 RENEWED                                        | ″                                        | renewed |
| 3 CANCELED                                       | ″                                        | auto_renew_disabled |
| 4 PURCHASED                                      | ″ (`plan_changed` if `linkedPurchaseToken` matches a stored chain) | purchased |
| 5 ON_HOLD                                        | ″                                        | renewal_failed |
| 6 IN_GRACE_PERIOD                                | ″                                        | grace_period_started |
| 7 RESTARTED                                      | ″                                        | auto_renew_enabled |
| 8, 19, 22 (price change / step-up)               | ″                                        | price_change |
| 10 PAUSED                                        | ″                                        | paused |
| 12 REVOKED                                       | ″ then force `status=revoked`, `revokedAt=now` | revoked |
| 13 EXPIRED                                       | ″                                        | expired |
| 20 PENDING_PURCHASE_CANCELED                     | ″                                        | canceled |
| other subscription types (9, 11, 17, 18 …)      | ″                                        | other |
| `oneTimeProductNotification` 1 PURCHASED         | fetch productsv2                         | purchased |
| `oneTimeProductNotification` 2 CANCELED          | fetch productsv2                         | canceled |
| `voidedPurchaseNotification`                     | find record by token; set `status=revoked`, `revokedAt=now` (refundType 2 = partial quantity: keep status, still emit) | refunded |
| `pendingRefundReviewNotification` / unknown      | none                                     | other |

`rawType`: subscription → `SUBSCRIPTION_<NAME>` (e.g. `SUBSCRIPTION_RENEWED`, unknown → `SUBSCRIPTION_<n>`),
one-time → `ONE_TIME_PRODUCT_PURCHASED` / `ONE_TIME_PRODUCT_CANCELED`, `VOIDED_PURCHASE`, `TEST`, `UNKNOWN`.

If a voided token is not stored → `purchase: null`, event still `refunded`.
If the API says the token is not found (404/410) for a subscription/one-time notification → `purchase: null`, event as mapped
(don't fail the webhook: there is nothing to retry).

Upsert for Google: resolve the chain like §7.3 step 2 (by `linkedPurchaseToken`, then by token); unknown → insert
`userId = null`, key = the token (or linked token chain root if found).

## 9. PurchaseStore contract

```
interface PurchaseStore {
  findByKey(platform, key): Promise<PurchaseRecord | null>
  findByToken(platform, token): Promise<PurchaseRecord | null>        // Google: any token in record.tokens
  findByUser(userId): Promise<PurchaseRecord[]>
  insert(record): Promise<boolean>                                    // false if (platform,key) exists — MUST be atomic
  replace(record, expectedVersion): Promise<boolean>                  // false if stored version != expectedVersion — MUST be atomic
  rememberNotification(platform, id): Promise<boolean>                // false if already remembered — MUST be atomic
  forgetNotification(platform, id): Promise<void>
}
PurchaseRecord { platform, key, userId: string|null, purchase: Purchase, tokens: string[],
                 lastEventAt: Date, claimedAt: Date|null, version: int, createdAt: Date, updatedAt: Date }

`claimedAt` is set by the first successful claim and never cleared (not even by `releaseUser`), so a released
consumable can't be re-granted to a new account. Records inserted by webhooks start with `claimedAt = null`.
```

Node ships `MemoryPurchaseStore` (tests/dev) and documents an SQL recipe (unique `(platform,key)`,
unique `(platform, token)` table, `UPDATE … WHERE version = ?`). Laravel ships `DatabasePurchaseStore`
(migrations: `iap_purchases` unique(platform,key) with promoted columns for querying, `iap_purchase_tokens`
unique(platform,token), `iap_notifications` unique(platform,notification_id)).

## 10. Errors

Base `IapError` (PHP `IapException`) with `code`, `platform` (nullable), `details`, `cause`.

| class (PHP: …Exception) | codes                                                        |
| ----------------------- | ------------------------------------------------------------ |
| ConfigurationError      | CONFIGURATION_ERROR                                          |
| ValidationError         | VALIDATION_ERROR (has `fields`)                              |
| AuthenticationError     | AUTHENTICATION_FAILED                                        |
| StoreApiError           | STORE_API_ERROR (has `statusCode`, `responseBody`, `retryable`) |
| NetworkError            | NETWORK_ERROR, TIMEOUT                                       |
| VerificationError       | INVALID_SIGNATURE, WRONG_APP, PRODUCT_MISMATCH, INVALID_NOTIFICATION |
| PolicyError             | ENVIRONMENT_NOT_ALLOWED, UNKNOWN_PRODUCT, FAMILY_SHARING_NOT_ALLOWED |
| PurchaseNotFoundError   | PURCHASE_NOT_FOUND                                           |
| OwnershipError          | ALREADY_OWNED, ACCOUNT_MISMATCH                              |
| IapError (base)         | CONCURRENT_MODIFICATION                                      |

Never include private keys, access tokens, JWTs, `accountTokenSecret` or other users' ids in messages/details/logs.

## 11. HTTP

Shared options `timeoutMs` (15000), `retries` (2, exponential backoff 200ms·2^n, only where §5.3/§6.3 say retryable),
injectable fetch (Node) / Laravel `Http` facade (fakeable). User-Agent `iap-guard-node/<v>` / `iap-guard-laravel/<v>`.

## 12. Clock

All "now" comparisons use an injectable clock (Node `clock: () => Date`; Laravel `now()` so `Carbon::setTestNow` works).
Fixture "now" is **2026-11-18T12:00:00Z (1795003200000 ms)**.

## 13. Test fixtures (`fixtures/`)

Generated by `spec/tools/generate-fixtures.mjs` (OpenSSL + node:crypto). Never use these keys outside tests.

- `apple/certs/root.pem` — test root (trusted in tests instead of Apple Root CA - G3)
- `apple/keys/api-private-key.p8`, `apple/api.json` — fake App Store Server API credentials + expected JWT header/claims
- `apple/jws.json` — named signed transactions/renewal infos/notifications + decoded payloads + expected normalized Purchase
  and expected error code per invalid case
- `google/service-account.json` — fake service account (RSA)
- `google/oidc.json` — JWKS + named Pub/Sub OIDC tokens (valid, wrong audience, expired, wrong issuer, unknown kid, bad signature)
- `google/api.json` — named `subscriptionsv2` / `productsv2` responses + expected normalized Purchase
- `google/rtdn.json` — named Pub/Sub push bodies
- `account-tokens.json` — `{ secret, cases: [{ userId, token }] }`
