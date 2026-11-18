import { VerificationError } from '../core/errors/index.js';
import { isRecord, num, obj, str, type JsonObject } from '../core/guards.js';
import type { NotificationEvent } from '../core/types.js';
import { base64Decode } from '../crypto/base64url.js';

/** RTDN `subscriptionNotification.notificationType` → name (rawType suffix) and event. */
const SUBSCRIPTION_TYPES: Readonly<Record<number, readonly [string, NotificationEvent]>> = {
  1: ['RECOVERED', 'recovered'],
  2: ['RENEWED', 'renewed'],
  3: ['CANCELED', 'auto_renew_disabled'],
  4: ['PURCHASED', 'purchased'],
  5: ['ON_HOLD', 'renewal_failed'],
  6: ['IN_GRACE_PERIOD', 'grace_period_started'],
  7: ['RESTARTED', 'auto_renew_enabled'],
  8: ['PRICE_CHANGE_CONFIRMED', 'price_change'],
  9: ['DEFERRED', 'other'],
  10: ['PAUSED', 'paused'],
  11: ['PAUSE_SCHEDULE_CHANGED', 'other'],
  12: ['REVOKED', 'revoked'],
  13: ['EXPIRED', 'expired'],
  17: ['ITEMS_CHANGED', 'other'],
  18: ['CANCELLATION_SCHEDULED', 'other'],
  19: ['PRICE_CHANGE_UPDATED', 'price_change'],
  20: ['PENDING_PURCHASE_CANCELED', 'canceled'],
  22: ['PRICE_STEP_UP_CONSENT_UPDATED', 'price_change'],
};

/** What the handler must do for a parsed RTDN. */
export type GoogleNotificationAction =
  | { kind: 'none' }
  | { kind: 'subscription'; token: string; forceRevoked: boolean }
  | { kind: 'product'; token: string }
  | { kind: 'voided'; token: string; partial: boolean };

export interface ParsedGoogleNotification {
  id: string;
  packageName: string;
  event: NotificationEvent;
  rawType: string;
  action: GoogleNotificationAction;
  /** The decoded `DeveloperNotification`. */
  notification: JsonObject;
}

function invalid(message: string): VerificationError {
  return new VerificationError('INVALID_NOTIFICATION', message, { platform: 'google' });
}

/** Parses a Pub/Sub push body (raw or parsed) into an RTDN (SPEC §8.2). */
export function parseGooglePush(body: unknown): ParsedGoogleNotification {
  let parsed: unknown = body;
  if (typeof body === 'string' || body instanceof Uint8Array) {
    try {
      parsed = JSON.parse(Buffer.from(body).toString('utf8'));
    } catch {
      throw invalid('Body is not JSON');
    }
  }
  const message = isRecord(parsed) ? obj(parsed.message) : undefined;
  if (!message) throw invalid('Body has no Pub/Sub message');
  const id = str(message.messageId) ?? str(message.message_id);
  if (id === undefined || id === '') throw invalid('Pub/Sub message has no messageId');

  const bytes = typeof message.data === 'string' ? base64Decode(message.data) : null;
  let notification: unknown = null;
  if (bytes) {
    try {
      notification = JSON.parse(bytes.toString('utf8'));
    } catch {
      notification = null;
    }
  }
  if (!isRecord(notification)) throw invalid('Pub/Sub message data is not base64 JSON');

  const packageName = str(notification.packageName);
  if (packageName === undefined) throw invalid('Notification has no packageName');
  return { id, packageName, notification, ...classify(notification) };
}

function classify(n: JsonObject): Pick<ParsedGoogleNotification, 'event' | 'rawType' | 'action'> {
  const none = { kind: 'none' } as const;
  if (n.testNotification !== undefined) return { event: 'test', rawType: 'TEST', action: none };

  const subscription = obj(n.subscriptionNotification);
  if (subscription) {
    const type = num(subscription.notificationType) ?? -1;
    const token = requireToken(subscription.purchaseToken);
    const [name, event] = SUBSCRIPTION_TYPES[type] ?? [String(type), 'other' as const];
    return {
      event,
      rawType: `SUBSCRIPTION_${name}`,
      action: { kind: 'subscription', token, forceRevoked: type === 12 },
    };
  }

  const oneTime = obj(n.oneTimeProductNotification);
  if (oneTime) {
    const type = num(oneTime.notificationType);
    const token = requireToken(oneTime.purchaseToken);
    if (type === 1) {
      return {
        event: 'purchased',
        rawType: 'ONE_TIME_PRODUCT_PURCHASED',
        action: { kind: 'product', token },
      };
    }
    if (type === 2) {
      return {
        event: 'canceled',
        rawType: 'ONE_TIME_PRODUCT_CANCELED',
        action: { kind: 'product', token },
      };
    }
    return { event: 'other', rawType: 'UNKNOWN', action: none };
  }

  const voided = obj(n.voidedPurchaseNotification);
  if (voided) {
    return {
      event: 'refunded',
      rawType: 'VOIDED_PURCHASE',
      action: {
        kind: 'voided',
        token: requireToken(voided.purchaseToken),
        partial: num(voided.refundType) === 2,
      },
    };
  }
  return { event: 'other', rawType: 'UNKNOWN', action: none };
}

function requireToken(value: unknown): string {
  const token = str(value);
  if (token === undefined || token === '') throw invalid('Notification has no purchaseToken');
  return token;
}
