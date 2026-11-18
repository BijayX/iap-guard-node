import { AuthenticationError, StoreApiError } from '../core/errors/index.js';
import type { Clock } from '../core/clock.js';
import { isRecord, num, str } from '../core/guards.js';
import type { HttpClient } from '../core/http/http-client.js';
import { signJwt } from '../crypto/jwt.js';
import { GOOGLE_DEFAULTS, type ResolvedGoogleConfig } from './google.config.js';

/** Refresh this long before Google's `expires_in`. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * OAuth 2.0 service-account flow (SPEC §6.2): an RS256 JWT assertion exchanged for an access
 * token. Tokens are cached until `expires_in - 60s`; concurrent callers share one request.
 */
export class ServiceAccountAuth {
  private cached: { token: string; expiresAt: number } | null = null;
  private inFlight: Promise<string> | null = null;

  constructor(
    private readonly config: ResolvedGoogleConfig,
    private readonly http: HttpClient,
    private readonly clock: Clock,
  ) {}

  async accessToken(): Promise<string> {
    if (this.cached && this.clock().getTime() < this.cached.expiresAt) return this.cached.token;
    this.inFlight ??= this.fetchToken().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Drop the cached token (e.g. after the API answered 401). */
  invalidate(): void {
    this.cached = null;
  }

  private async fetchToken(): Promise<string> {
    const now = this.clock().getTime();
    const iat = Math.floor(now / 1000);
    const assertion = signJwt(
      'RS256',
      { alg: 'RS256', typ: 'JWT' },
      {
        iss: this.config.clientEmail,
        scope: GOOGLE_DEFAULTS.scope,
        aud: this.config.tokenUrl,
        iat,
        exp: iat + 3600,
      },
      this.config.privateKey,
    );
    const response = await this.http.send({
      method: 'POST',
      url: this.config.tokenUrl,
      form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion },
      retry: false,
    });

    const body = isRecord(response.body) ? response.body : {};
    if (response.status === 400 || response.status === 401) {
      // The body names the OAuth error (e.g. invalid_grant); it never echoes the assertion.
      throw new AuthenticationError('Google rejected the service account credentials', {
        platform: 'google',
        details: { statusCode: response.status, error: str(body.error) ?? null },
      });
    }
    const token = str(body.access_token);
    const expiresIn = num(body.expires_in);
    if (response.status !== 200 || token === undefined || expiresIn === undefined) {
      throw new StoreApiError(`Google token endpoint error ${response.status}`, {
        platform: 'google',
        statusCode: response.status,
      });
    }
    this.cached = { token, expiresAt: now + expiresIn * 1000 - EXPIRY_MARGIN_MS };
    return token;
  }
}
