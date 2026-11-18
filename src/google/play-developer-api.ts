import { AuthenticationError, PurchaseNotFoundError, StoreApiError } from '../core/errors/index.js';
import { isRecord, obj, str, type JsonObject } from '../core/guards.js';
import type { HttpClient } from '../core/http/http-client.js';
import type { ResolvedGoogleConfig } from './google.config.js';
import type { ServiceAccountAuth } from './service-account-auth.js';

/** Google Play Developer API v3 — the purchase endpoints this library uses (SPEC §6.3). */
export class PlayDeveloperApi {
  constructor(
    private readonly config: ResolvedGoogleConfig,
    private readonly auth: ServiceAccountAuth,
    private readonly http: HttpClient,
  ) {}

  getSubscription(token: string): Promise<JsonObject> {
    return this.request('GET', `purchases/subscriptionsv2/tokens/${enc(token)}`);
  }

  getProduct(token: string): Promise<JsonObject> {
    return this.request('GET', `purchases/productsv2/tokens/${enc(token)}`);
  }

  async acknowledgeSubscription(productId: string, token: string): Promise<void> {
    await this.request(
      'POST',
      `purchases/subscriptions/${enc(productId)}/tokens/${enc(token)}:acknowledge`,
    );
  }

  async acknowledgeProduct(productId: string, token: string): Promise<void> {
    await this.request(
      'POST',
      `purchases/products/${enc(productId)}/tokens/${enc(token)}:acknowledge`,
    );
  }

  async consumeProduct(productId: string, token: string): Promise<void> {
    await this.request(
      'POST',
      `purchases/products/${enc(productId)}/tokens/${enc(token)}:consume`,
      false,
    );
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    withBody = true,
  ): Promise<JsonObject> {
    const accessToken = await this.auth.accessToken();
    const response = await this.http.send({
      method,
      url: `${this.config.baseUrl}applications/${enc(this.config.packageName)}/${path}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      ...(method === 'POST' && withBody ? { json: {} } : {}),
      // GETs are safe to retry; acknowledge/consume are idempotent.
      retry: true,
    });
    const { status, body } = response;
    if (status >= 200 && status < 300) {
      if (method === 'POST') return {};
      if (isRecord(body)) return body;
      throw new StoreApiError('Unexpected Play Developer API response', {
        platform: 'google',
        statusCode: status,
        responseBody: body,
        retryable: false,
      });
    }

    const error = isRecord(body) ? obj(body.error) : undefined;
    const message = str(error?.message);
    const details = { statusCode: status, status: str(error?.status) ?? null };
    if (status === 401 || status === 403) {
      if (status === 401) this.auth.invalidate();
      throw new AuthenticationError(
        'Play Developer API rejected the service account (check its Play Console permissions)',
        { platform: 'google', details },
      );
    }
    if (status === 400 || status === 404 || status === 410) {
      throw new PurchaseNotFoundError(
        status === 410 ? 'Purchase token expired too long ago' : 'Purchase token not found',
        { platform: 'google', details },
      );
    }
    throw new StoreApiError(`Play Developer API error ${status}${message ? `: ${message}` : ''}`, {
      platform: 'google',
      statusCode: status,
      responseBody: body,
      retryable: status === 429 || status >= 500,
      details,
    });
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}
