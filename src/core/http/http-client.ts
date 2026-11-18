import { NetworkError } from '../errors/index.js';
import type { Logger, Platform } from '../types.js';
import { VERSION } from '../version.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Transport options shared by both stores (SPEC §11). */
export interface HttpOptions {
  /** Per-attempt timeout. Default 15 000 ms. */
  timeoutMs?: number;
  /** Extra attempts for retryable requests on network errors, 429 and 5xx. Default 2. */
  retries?: number;
  /** Base delay for exponential backoff (delay × 2^attempt). Default 200 ms. */
  retryDelayMs?: number;
  /** Custom fetch — for proxies, instrumentation or tests. Defaults to global `fetch`. */
  fetch?: FetchLike;
}

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  /** Serialised as JSON. */
  json?: unknown;
  /** Sent as `application/x-www-form-urlencoded`. */
  form?: Record<string, string>;
  /** Retry on network errors, 429 and 5xx. Only where SPEC §5.3 / §6.3 allow. */
  retry: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON, or the raw text when the body is not JSON, or `null` when empty. */
  body: unknown;
}

export const USER_AGENT = `iap-guard-node/${VERSION}`;

/** `Retry-After` values above this are not waited for; the error is surfaced instead. */
const MAX_RETRY_AFTER_SECONDS = 10;

/**
 * Thin fetch wrapper with timeouts, bounded retries and safe logging. It does not interpret
 * status codes beyond "retry or not" — each store API maps them to errors itself.
 */
export class HttpClient {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly platform: Platform,
    options: HttpOptions = {},
    private readonly logger?: Logger,
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retries = Math.max(0, options.retries ?? 2);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 200);
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const attempts = request.retry ? this.retries + 1 : 1;
    let lastError: NetworkError | undefined;
    let delay = 0;

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(delay);
      delay = this.retryDelayMs * 2 ** attempt;
      try {
        const response = await this.attempt(request);
        const retryableStatus = response.status === 429 || response.status >= 500;
        if (!retryableStatus || attempt === attempts - 1) return response;
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        if (retryAfter !== null) {
          if (retryAfter > MAX_RETRY_AFTER_SECONDS) return response;
          delay = retryAfter * 1000;
        }
        this.logger?.warn(
          'iap-guard: store API unavailable, retrying',
          this.logContext(request, { status: response.status, attempt }),
        );
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
        lastError = error;
        if (attempt < attempts - 1) {
          this.logger?.warn(
            'iap-guard: network error, retrying',
            this.logContext(request, { code: error.code, attempt }),
          );
        }
      }
    }
    // Only reached after a NetworkError on the last attempt.
    throw lastError ?? new NetworkError('Request failed', { platform: this.platform });
  }

  private async attempt(request: HttpRequest): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...request.headers,
    };
    const init: RequestInit = {
      method: request.method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (request.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(request.json);
    } else if (request.form !== undefined) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(request.form).toString();
    }

    const started = Date.now();
    let response: Response;
    let text: string;
    try {
      response = await this.fetchFn(request.url, init);
      text = await response.text();
    } catch (error) {
      const timeout = isTimeout(error);
      throw new NetworkError(
        timeout
          ? `${this.platform} store API did not respond within ${this.timeoutMs} ms`
          : `Could not reach the ${this.platform} store API`,
        {
          platform: this.platform,
          timeout,
          cause: error,
          details: { url: redactUrl(request.url) },
        },
      );
    }

    this.logger?.debug(
      'iap-guard: request',
      this.logContext(request, { status: response.status, durationMs: Date.now() - started }),
    );
    return { status: response.status, headers: response.headers, body: parseBody(text) };
  }

  /** Never includes headers or bodies: they carry bearer tokens, JWTs and assertions. */
  private logContext(
    request: HttpRequest,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      platform: this.platform,
      method: request.method,
      url: redactUrl(request.url),
      ...extra,
    };
  }
}

/** Drops the query string and masks purchase tokens in Play API paths. */
export function redactUrl(url: string): string {
  const index = url.indexOf('?');
  const path = index === -1 ? url : url.slice(0, index);
  return path.replace(/\/tokens\/[^/:]+/g, '/tokens/[redacted]');
}

function parseBody(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
