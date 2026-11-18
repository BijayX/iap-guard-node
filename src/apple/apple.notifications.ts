import { VerificationError } from '../core/errors/index.js';
import { isRecord, num, str, type JsonObject } from '../core/guards.js';
import type { NotificationEvent, Purchase } from '../core/types.js';
import { normalizeAppleTransaction } from './apple.normalizer.js';
import type { SignedDataVerifier } from './signed-data-verifier.js';

/** SPEC §8.1 notificationType/subtype → event. */
export function appleNotificationEvent(
  type: string,
  subtype: string | undefined,
): NotificationEvent {
  switch (type) {
    case 'SUBSCRIBED':
    case 'ONE_TIME_CHARGE':
      return 'purchased';
    case 'DID_RENEW':
      return subtype === 'BILLING_RECOVERY' ? 'recovered' : 'renewed';
    case 'DID_FAIL_TO_RENEW':
      return subtype === 'GRACE_PERIOD' ? 'grace_period_started' : 'renewal_failed';
    case 'DID_CHANGE_RENEWAL_STATUS':
      if (subtype === 'AUTO_RENEW_ENABLED') return 'auto_renew_enabled';
      if (subtype === 'AUTO_RENEW_DISABLED') return 'auto_renew_disabled';
      return 'other';
    case 'DID_CHANGE_RENEWAL_PREF':
      return 'plan_changed';
    case 'EXPIRED':
    case 'GRACE_PERIOD_EXPIRED':
      return 'expired';
    case 'REFUND':
      return 'refunded';
    case 'REVOKE':
      return 'revoked';
    case 'REFUND_REVERSED':
      return 'refund_reversed';
    case 'PRICE_INCREASE':
    case 'PRICE_CHANGE':
      return 'price_change';
    case 'CONSUMPTION_REQUEST':
      return 'consumption_request';
    case 'TEST':
      return 'test';
    default:
      return 'other';
  }
}

export interface DecodedAppleNotification {
  id: string;
  event: NotificationEvent;
  rawType: string;
  /** Null for notifications without transaction data (TEST, summaries, external tokens). */
  purchase: Purchase | null;
  payload: JsonObject;
}

/** Extracts `signedPayload` from a raw (string/Buffer) or parsed body. */
export function readSignedPayload(body: unknown): string {
  let parsed: unknown = body;
  if (typeof body === 'string' || body instanceof Uint8Array) {
    try {
      parsed = JSON.parse(Buffer.from(body).toString('utf8'));
    } catch {
      parsed = null;
    }
  }
  const signedPayload = isRecord(parsed) ? str(parsed.signedPayload) : undefined;
  if (signedPayload === undefined || signedPayload === '') {
    throw new VerificationError('INVALID_NOTIFICATION', 'Body must be JSON with a signedPayload', {
      platform: 'apple',
    });
  }
  return signedPayload;
}

/**
 * Verifies a notification body and everything signed inside it (SPEC §8.1). Builds the
 * Purchase with `status = data.status` and `signedAt = notification signedDate`.
 */
export function decodeAppleNotification(
  verifier: SignedDataVerifier,
  body: unknown,
): DecodedAppleNotification {
  const { payload, data } = verifier.verifyNotification(readSignedPayload(body));
  const type = str(payload.notificationType) ?? '';
  const subtype = str(payload.subtype);

  let purchase: Purchase | null = null;
  if (data.signedTransactionInfo !== undefined) {
    const tx = verifier.verifyTransaction(data.signedTransactionInfo);
    const renewalInfo =
      data.signedRenewalInfo === undefined
        ? null
        : verifier.verifyRenewalInfo(data.signedRenewalInfo);
    purchase = normalizeAppleTransaction(tx, {
      renewalInfo,
      status: num(data.status) ?? null,
      signedAt: new Date(num(payload.signedDate) ?? 0),
    });
  }

  return {
    id: str(payload.notificationUUID) ?? '',
    event: appleNotificationEvent(type, subtype),
    rawType: subtype ? `${type}/${subtype}` : type,
    purchase,
    payload,
  };
}
