import { AuthenticationError, PurchaseNotFoundError, StoreApiError } from '../core/errors/index.js';
import type { Clock } from '../core/clock.js';
import { isRecord, num, str, type JsonObject } from '../core/guards.js';
import type { HttpClient } from '../core/http/http-client.js';
import type { Environment } from '../core/types.js';
import { signJwt } from '../crypto/jwt.js';
import type { ResolvedAppleApiConfig } from './apple.config.js';

/** Apple: "Transaction id not found." */
export const TRANSACTION_ID_NOT_FOUND = 4040010;

const TOKEN_LIFETIME_S = 300;
/** Regenerate this long before the token expires. */
const TOKEN_REFRESH_MARGIN_S = 60;

/**
 * App Store Server API client (SPEC §5.3). Only the two endpoints this library needs.
 * Responses' signed values are returned as-is; the caller verifies them like client input.
 */
export class AppStoreServerApi {
  private cached: { jwt: string; refreshAt: number } | null = null;

  constructor(
    private readonly api: ResolvedAppleApiConfig,
    private readonly bundleId: string,
    private readonly http: HttpClient,
    private readonly clock: Clock,
  ) {}

  /** `GET /inApps/v1/transactions/{transactionId}` → `signedTransactionInfo`. */
  async getTransactionInfo(transactionId: string, environment: Environment): Promise<string> {
    const body = await this.get(
      `/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
      environment,
    );
    const signed = str(body.signedTransactionInfo);
    if (signed === undefined) throw malformed(body);
    return signed;
  }

  /** `GET /inApps/v1/subscriptions/{transactionId}` → all subscription statuses. */
  async getAllSubscriptionStatuses(
    transactionId: string,
    environment: Environment,
  ): Promise<JsonObject> {
    return this.get(`/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`, environment);
  }

  /** Bearer token: ES256 JWT, cached and regenerated a minute before its 5-minute expiry. */
  authorizationToken(): string {
    const now = Math.floor(this.clock().getTime() / 1000);
    if (this.cached && now < this.cached.refreshAt) return this.cached.jwt;
    const jwt = signJwt(
      'ES256',
      { alg: 'ES256', kid: this.api.keyId, typ: 'JWT' },
      {
        iss: this.api.issuerId,
        iat: now,
        exp: now + TOKEN_LIFETIME_S,
        aud: 'appstoreconnect-v1',
        bid: this.bundleId,
      },
      this.api.privateKey,
    );
    this.cached = { jwt, refreshAt: now + TOKEN_LIFETIME_S - TOKEN_REFRESH_MARGIN_S };
    return jwt;
  }

  private async get(path: string, environment: Environment): Promise<JsonObject> {
    const response = await this.http.send({
      method: 'GET',
      url: `${this.api.baseUrls[environment]}${path}`,
      headers: { Authorization: `Bearer ${this.authorizationToken()}` },
      retry: true,
    });
    const { status, body } = response;
    if (status === 200 && isRecord(body)) return body;
    if (status === 200) throw malformed(body);

    const errorCode = isRecord(body) ? num(body.errorCode) : undefined;
    const errorMessage = isRecord(body) ? str(body.errorMessage) : undefined;
    const details = { statusCode: status, errorCode: errorCode ?? null, environment };
    if (status === 401) {
      this.cached = null;
      throw new AuthenticationError(
        'App Store Server API rejected the credentials (issuerId, keyId or private key)',
        { platform: 'apple', details },
      );
    }
    if (status === 404 && errorCode === TRANSACTION_ID_NOT_FOUND) {
      throw new PurchaseNotFoundError('Transaction id not found', { platform: 'apple', details });
    }
    throw new StoreApiError(
      `App Store Server API error ${status}${errorMessage ? `: ${errorMessage}` : ''}`,
      {
        platform: 'apple',
        statusCode: status,
        responseBody: body,
        retryable: status === 429 || status >= 500,
        details,
      },
    );
  }
}

function malformed(body: unknown): StoreApiError {
  return new StoreApiError('Unexpected App Store Server API response', {
    platform: 'apple',
    statusCode: 200,
    responseBody: body,
    retryable: false,
  });
}
