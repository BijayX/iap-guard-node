# Express example

A minimal server showing the four things every app needs: account tokens, claiming purchases,
reading entitlements and receiving store webhooks.

```bash
cp .env.example .env   # fill in your bundle id, package name, keys
npm install
npm start
```

| Route                   | Auth           | Purpose                                                          |
| ----------------------- | -------------- | ---------------------------------------------------------------- |
| `GET /me/account-token` | user           | UUID for StoreKit `appAccountToken` / Play `obfuscatedAccountId` |
| `POST /purchases/claim` | user           | Verify a purchase and record it against the user                 |
| `GET /me/entitlements`  | user           | What the user may access right now                               |
| `POST /webhooks/apple`  | signed payload | App Store Server Notifications V2                                |
| `POST /webhooks/google` | Pub/Sub OIDC   | Google Play RTDN via Pub/Sub push                                |

```bash
curl -H 'X-User-Id: user-1' http://localhost:3000/me/account-token
curl -H 'X-User-Id: user-1' -H 'Content-Type: application/json' \
  -d '{"platform":"apple","signedTransaction":"eyJ…"}' http://localhost:3000/purchases/claim
```

> **`src/fake-auth.ts` is fake.** It trusts an `X-User-Id` header so you can try the routes with
> curl. Replace it with your real authentication before using any of this.

`MemoryPurchaseStore` forgets everything on restart; use a database-backed store in production.
The webhook routes read the **raw** body (`express.raw`) so nothing is lost or re-encoded.
