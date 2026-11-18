import express, { type ErrorRequestHandler } from 'express';
import {
  OwnershipError,
  PolicyError,
  ValidationError,
  VerificationError,
  webhookResponse,
  type ClaimInput,
} from '@bijayx/iap-guard';
import { currentUserId, fakeAuth } from './fake-auth.ts';
import { guard } from './guard.ts';

const app = express();

// ---------------------------------------------------------------- app endpoints (authenticated)

/** The app passes this to StoreKit `.appAccountToken(...)` / Play `setObfuscatedAccountId(...)`. */
app.get('/me/account-token', fakeAuth, (_req, res) => {
  res.json({ accountToken: guard.accountTokenFor(currentUserId(res)) });
});

/**
 * Body, from the app after a purchase or restore:
 *   iOS:     { "platform": "apple", "signedTransaction": "<Transaction.jwsRepresentation>" }
 *   Android: { "platform": "google", "type": "subscription" | "one_time", "purchaseToken": "…", "productId": "…" }
 */
app.post('/purchases/claim', fakeAuth, express.json(), async (req, res) => {
  const body = req.body as Record<string, unknown>;
  // userId always comes from your auth, never from the request body.
  const input = { ...body, userId: currentUserId(res) } as ClaimInput;
  const result = await guard.claim(input);

  if (result.isNew && result.purchase.type === 'consumable') {
    // Grant consumables exactly once, here (e.g. add result.purchase.quantity × 100 coins).
  }
  if (result.ownership === 'transferred' && result.previousUserId) {
    // conflictPolicy "transfer" only: revoke whatever you granted result.previousUserId.
  }

  res.json({
    entitled: result.isEntitled,
    productId: result.purchase.productId,
    status: result.purchase.status,
    expiresAt: result.purchase.expiresAt,
    isNew: result.isNew,
    ownership: result.ownership,
    // Lets the app warn "you're already subscribed on another platform".
    alsoActive: result.otherActive.map((p) => ({ platform: p.platform, productId: p.productId })),
  });
});

app.get('/me/entitlements', fakeAuth, async (_req, res) => {
  const purchases = await guard.entitlements(currentUserId(res));
  res.json(
    purchases.map((p) => ({
      platform: p.platform,
      productId: p.productId,
      status: p.status,
      expiresAt: p.expiresAt,
      willRenew: p.willRenew,
    })),
  );
});

// ---------------------------------------------------------------- store webhooks (no user auth)

// App Store Server Notifications V2 → POST { signedPayload }
app.post('/webhooks/apple', express.raw({ type: '*/*' }), async (req, res) => {
  const { status, body } = await webhookResponse(() => guard.handleAppleNotification(req.body));
  res.status(status).json(body);
});

// Google Play RTDN via a Pub/Sub push subscription with OIDC authentication.
app.post('/webhooks/google', express.raw({ type: '*/*' }), async (req, res) => {
  const { status, body } = await webhookResponse(async () => {
    const result = await guard.handleGoogleNotification({
      body: req.body, // raw Buffer
      headers: req.headers, // Authorization: Bearer <OIDC token>
      query: req.query, // ?token=… when using pubsub.verificationToken instead
    });
    if (result.event === 'refunded' && result.userId && result.purchase?.type === 'consumable') {
      // Claw back the consumable from result.userId.
    }
    return result;
  });
  res.status(status).json(body);
});

// ---------------------------------------------------------------- errors

const errors: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ValidationError) {
    res.status(422).json({ error: error.code, fields: error.fields });
  } else if (error instanceof OwnershipError) {
    // ALREADY_OWNED / ACCOUNT_MISMATCH: the purchase belongs to another account.
    res.status(409).json({ error: error.code });
  } else if (error instanceof VerificationError || error instanceof PolicyError) {
    res.status(400).json({ error: error.code });
  } else {
    console.error(error);
    res.status(502).json({ error: 'STORE_UNAVAILABLE' });
  }
};
app.use(errors);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`iap-guard example listening on http://localhost:${port}`);
});
