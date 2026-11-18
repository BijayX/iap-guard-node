# Security policy

This library decides who gets paid content, so security reports are handled first.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository.

Include the affected version, a description, and steps or code to reproduce (a forged JWS,
a webhook body, a race). You will get an acknowledgement within 72 hours and a fix or
mitigation plan within 14 days for confirmed issues.

Especially in scope: anything that makes a forged or foreign purchase verify, lets one app
user take over another user's purchase, replays a consumable, or leaks secrets into errors
or logs.

## Supported versions

Only the latest minor release receives security fixes.

## Known limitations (by design)

- No OCSP / CRL revocation checks for Apple certificates (same as Apple's library with online
  checks disabled). See the README.
- StoreKit 1 receipts (`verifyReceipt`) are not supported.
