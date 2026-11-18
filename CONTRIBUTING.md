# Contributing

Thanks for helping. Bug reports, store API changes and new edge cases are all welcome.

## Setup

```bash
npm install
npm run ci       # typecheck + lint + format check + tests with coverage + build
```

`npm test` runs the suite once; `npm run test:watch` re-runs on change.

## Layout

```
src/
  index.ts                  public exports (semver applies to everything here)
  iap-guard.ts              IapGuard: verify, claim, notifications, entitlements
  core/                     platform-independent building blocks
    types.ts                Purchase, inputs, results
    errors/                 error hierarchy and codes (SPEC §10)
    http/                   fetch wrapper: timeouts, bounded retries, redacted logging
    entitlement.ts          isEntitled (SPEC §3)
    account-token.ts        HMAC-derived UUIDs (SPEC §7.5)
    purchase.ts, guards.ts, clock.ts, version.ts
  crypto/                   node:crypto only
    der.ts                  minimal DER reader (certificate validity + extensions)
    x509-chain.ts           Apple x5c chain rules
    jws.ts, jwt.ts          ES256/RS256 sign + verify, JWK import
  apple/                    App Store: config, root CA, signed data, Server API, notifications
  google/                   Play: config, OAuth, Developer API, Pub/Sub auth, RTDN, acknowledge
  ownership/                claim algorithm, notification upserts, release (SPEC §7)
  store/                    PurchaseStore interface + MemoryPurchaseStore
  http/webhook-response.ts  result/error → HTTP status
tests/
  fixtures/                 shared with the Laravel package — generated, never edit by hand
  helpers/                  fake fetch, fixture loaders, makeGuard()
  apple/ google/ ownership/ unit/
```

## Rules

- `SPEC.md` is the contract shared with `bijayx/iap-guard-laravel`. Behaviour changes start
  there; the fixtures' `expected` objects are the reference output.
- Zero runtime dependencies. Crypto is `node:crypto` only.
- Never put private keys, access tokens, JWTs, the account-token secret or other users' ids
  in error messages, `details` or logs. `tests/unit/secrets.test.ts` checks this — extend it
  when you add a failure path.
- Tests never touch the network: use `fakeFetch` and `makeGuard()` from `tests/helpers`.
- Every edge case in SPEC §7.4 has a named test in `tests/ownership/edge-cases.test.ts`.
- Coverage thresholds are enforced in `vitest.config.ts`.

## Commits and releases

Use clear, imperative commit messages. Releases follow semver; update `CHANGELOG.md` and
`src/core/version.ts` in the same PR (a test checks the version matches `package.json`).
