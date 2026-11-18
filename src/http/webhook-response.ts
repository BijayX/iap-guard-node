import { IapError, PolicyError, ValidationError, VerificationError } from '../core/errors/index.js';
import type { NotificationResult } from '../core/types.js';

export interface WebhookResponse {
  status: 200 | 400 | 500;
  body: Record<string, unknown>;
}

/**
 * Maps a notification result or error to an HTTP response (SPEC §8), for any framework:
 *
 * - 200: processed, duplicate or stale
 * - 400: `VerificationError` / `PolicyError` / `ValidationError` — forged, malformed, for
 *   another app or refused by policy
 * - 500: everything else (store, network, store API, configuration, and `AuthenticationError`
 *   — our own credentials rejected) so the platform retries later
 *
 * Bodies contain only codes, never error details.
 */
export function toWebhookResponse(outcome: unknown): WebhookResponse {
  if (isNotificationResult(outcome)) {
    return {
      status: 200,
      body: { ok: true, id: outcome.id, duplicate: outcome.duplicate, stale: outcome.stale },
    };
  }
  if (
    outcome instanceof VerificationError ||
    outcome instanceof PolicyError ||
    outcome instanceof ValidationError
  ) {
    return { status: 400, body: { ok: false, error: outcome.code } };
  }
  return {
    status: 500,
    body: { ok: false, error: outcome instanceof IapError ? outcome.code : 'INTERNAL_ERROR' },
  };
}

/** Runs a handler and returns the mapped response; never throws. */
export async function webhookResponse(
  handler: () => Promise<NotificationResult>,
): Promise<WebhookResponse> {
  try {
    return toWebhookResponse(await handler());
  } catch (error) {
    return toWebhookResponse(error);
  }
}

function isNotificationResult(value: unknown): value is NotificationResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Error) &&
    'platform' in value &&
    'event' in value &&
    'duplicate' in value
  );
}
