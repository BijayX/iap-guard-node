import { createHash, timingSafeEqual, type KeyObject } from 'node:crypto';
import { ConfigurationError, StoreApiError, VerificationError } from '../core/errors/index.js';
import type { Clock } from '../core/clock.js';
import { arr, isRecord, num, str } from '../core/guards.js';
import type { HttpClient } from '../core/http/http-client.js';
import type { WebhookRequest } from '../core/types.js';
import { decodeJwt, jwkToPublicKey, verifySignature } from '../crypto/jwt.js';
import type { ResolvedGoogleConfig } from './google.config.js';

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_S = 60;
const DEFAULT_JWKS_TTL_S = 3600;
/** An unknown `kid` triggers at most one refetch per this interval (forged tokens can't flood). */
const MIN_REFETCH_INTERVAL_MS = 60_000;

interface JwksCache {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
  expiresAt: number;
}

/**
 * Authenticates Pub/Sub push requests (SPEC §8.2): the push subscription's OIDC token
 * (RS256, Google JWKS, issuer, audience, expiry, optional service-account email), or a
 * shared `?token=` verification token.
 */
export class PubSubVerifier {
  private jwks: JwksCache | null = null;
  private inFlight: Promise<JwksCache> | null = null;

  constructor(
    private readonly config: ResolvedGoogleConfig,
    private readonly http: HttpClient,
    private readonly clock: Clock,
  ) {}

  async authenticate(request: WebhookRequest): Promise<void> {
    const { audience, verificationToken } = this.config.pubsub;
    if (audience !== null) {
      await this.verifyOidc(header(request.headers, 'authorization'), audience);
      return;
    }
    if (verificationToken !== null) {
      if (!constantTimeEqual(queryParam(request.query, 'token'), verificationToken)) {
        throw rejected('verification token mismatch');
      }
      return;
    }
    throw new ConfigurationError(
      'google.pubsub.audience or google.pubsub.verificationToken is required for notifications',
      { platform: 'google' },
    );
  }

  private async verifyOidc(authorization: string | undefined, audience: string): Promise<void> {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!match?.[1]) throw rejected('missing bearer token');
    const jwt = decodeJwt(match[1]);
    if (!jwt) throw rejected('malformed token');
    const { header: h, payload: claims } = jwt;
    if (h.alg !== 'RS256') throw rejected('alg must be RS256');
    const kid = str(h.kid);
    if (kid === undefined) throw rejected('missing kid');

    const key = await this.keyFor(kid);
    if (!key) throw rejected('unknown signing key');
    if (!verifySignature('RS256', jwt.signingInput, jwt.signature, key)) {
      throw rejected('bad signature');
    }

    const now = Math.floor(this.clock().getTime() / 1000);
    if (!ISSUERS.has(str(claims.iss) ?? '')) throw rejected('wrong issuer');
    if (claims.aud !== audience) throw rejected('wrong audience');
    const exp = num(claims.exp);
    const iat = num(claims.iat);
    if (exp === undefined || exp <= now - CLOCK_SKEW_S) throw rejected('token expired');
    if (iat === undefined || iat > now + CLOCK_SKEW_S) throw rejected('token issued in the future');
    const email = this.config.pubsub.serviceAccountEmail;
    if (email !== null && (claims.email !== email || claims.email_verified !== true)) {
      throw rejected('unexpected service account');
    }
  }

  /** Cached JWKS lookup; an unknown kid refetches once (rate limited). */
  private async keyFor(kid: string): Promise<KeyObject | undefined> {
    const now = this.clock().getTime();
    let cache = this.jwks && now < this.jwks.expiresAt ? this.jwks : await this.fetchJwks();
    if (!cache.keys.has(kid) && now - cache.fetchedAt >= MIN_REFETCH_INTERVAL_MS) {
      cache = await this.fetchJwks();
    }
    return cache.keys.get(kid);
  }

  private fetchJwks(): Promise<JwksCache> {
    this.inFlight ??= this.loadJwks().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async loadJwks(): Promise<JwksCache> {
    const response = await this.http.send({ method: 'GET', url: this.config.jwksUrl, retry: true });
    if (response.status !== 200 || !isRecord(response.body)) {
      // Our problem, not the sender's: let the platform retry (HTTP 500).
      throw new StoreApiError(`Could not load Google signing keys (HTTP ${response.status})`, {
        platform: 'google',
        statusCode: response.status,
        retryable: true,
      });
    }
    const keys = new Map<string, KeyObject>();
    for (const jwk of arr(response.body.keys)) {
      const kid = isRecord(jwk) ? str(jwk.kid) : undefined;
      const key = jwkToPublicKey(jwk);
      if (kid !== undefined && key?.asymmetricKeyType === 'rsa') keys.set(kid, key);
    }
    const maxAge = /max-age=(\d+)/i.exec(response.headers.get('cache-control') ?? '')?.[1];
    const fetchedAt = this.clock().getTime();
    const ttl = maxAge === undefined ? DEFAULT_JWKS_TTL_S : Number(maxAge);
    this.jwks = { keys, fetchedAt, expiresAt: fetchedAt + ttl * 1000 };
    return this.jwks;
  }
}

function rejected(reason: string): VerificationError {
  return new VerificationError(
    'INVALID_SIGNATURE',
    `Pub/Sub push authentication failed: ${reason}`,
    {
      platform: 'google',
    },
  );
}

/** Case-insensitive header lookup over `Headers` or a Node/Express header record. */
export function header(headers: WebhookRequest['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function queryParam(query: WebhookRequest['query'], name: string): string | undefined {
  if (!query) return undefined;
  if (query instanceof URLSearchParams) return query.get(name) ?? undefined;
  const value = query[name];
  return typeof value === 'string' ? value : undefined;
}

/** Compares SHA-256 digests so neither content nor length leaks through timing. */
function constantTimeEqual(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
