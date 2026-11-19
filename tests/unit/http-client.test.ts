import { describe, expect, it } from 'vitest';
import { NetworkError } from '../../src/index.js';
import { HttpClient, redactUrl } from '../../src/core/http/http-client.js';
import { fakeFetch } from '../helpers/fake-fetch.js';
import { recordingLogger } from '../helpers/fixtures.js';

const URL_ =
  'https://api.example.test/applications/p/purchases/subscriptionsv2/tokens/secret-token?key=abc';

describe('HttpClient', () => {
  it('sends JSON and form bodies with the right headers', async () => {
    const fetch = fakeFetch({
      'POST https://x.test/a': { status: 200, body: { ok: 1 } },
      'POST https://x.test/b': { status: 204 },
    });
    const http = new HttpClient('google', { fetch });
    const a = await http.send({
      method: 'POST',
      url: 'https://x.test/a',
      json: { a: 1 },
      retry: false,
    });
    const b = await http.send({
      method: 'POST',
      url: 'https://x.test/b',
      form: { x: 'y z' },
      retry: false,
    });
    expect(a.body).toEqual({ ok: 1 });
    expect(b.body).toBeNull();
    expect(fetch.calls[0]!.headers['Content-Type']).toBe('application/json');
    expect(fetch.calls[1]!.body).toBe('x=y+z');
    expect(fetch.calls[1]!.headers['User-Agent']).toBe('iap-guard-node/0.1.1');
  });

  it('returns non-JSON bodies as text', async () => {
    const http = new HttpClient('apple', {
      fetch: fakeFetch({ 'GET https://x.test/': { status: 502, body: '<html>' } }),
    });
    await expect(
      http.send({ method: 'GET', url: 'https://x.test/', retry: false }),
    ).resolves.toMatchObject({
      status: 502,
      body: '<html>',
    });
  });

  it('retries network errors for retryable requests, then throws NetworkError', async () => {
    const fetch = fakeFetch({
      'GET https://x.test/': [new Error('reset'), new Error('reset'), new Error('reset')],
    });
    const logs: Parameters<typeof recordingLogger>[0] = [];
    const http = new HttpClient(
      'google',
      { fetch, retries: 2, retryDelayMs: 1 },
      recordingLogger(logs),
    );
    const error = await http
      .send({ method: 'GET', url: 'https://x.test/', retry: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR', platform: 'google' });
    expect(fetch.calls).toHaveLength(3);
    expect(logs.filter((log) => log.level === 'warn')).toHaveLength(2);
  });

  it('does not retry non-retryable requests', async () => {
    const fetch = fakeFetch({ 'POST https://x.test/': [new Error('reset'), { status: 200 }] });
    const http = new HttpClient('google', { fetch, retries: 2 });
    await expect(
      http.send({ method: 'POST', url: 'https://x.test/', retry: false }),
    ).rejects.toBeInstanceOf(NetworkError);
    expect(fetch.calls).toHaveLength(1);
  });

  it('does not retry 5xx when retry is false', async () => {
    const fetch = fakeFetch({ 'POST https://x.test/': [{ status: 500 }, { status: 200 }] });
    const http = new HttpClient('google', { fetch, retries: 2 });
    await expect(
      http.send({ method: 'POST', url: 'https://x.test/', retry: false }),
    ).resolves.toMatchObject({ status: 500 });
  });

  it('maps timeouts to NetworkError(TIMEOUT)', async () => {
    const fetch = fakeFetch({
      'GET https://x.test/': Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    });
    const http = new HttpClient('apple', { fetch, retries: 0, timeoutMs: 5 });
    await expect(
      http.send({ method: 'GET', url: 'https://x.test/', retry: true }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining('5 ms'),
    });
  });

  it('aborts a hanging request after timeoutMs', async () => {
    const hanging = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const http = new HttpClient('apple', { fetch: hanging, retries: 0, timeoutMs: 20 });
    await expect(
      http.send({ method: 'GET', url: 'https://x.test/', retry: true }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('does not wait for Retry-After above 10 seconds', async () => {
    const fetch = fakeFetch({
      'GET https://x.test/': [{ status: 429, headers: { 'Retry-After': '120' } }, { status: 200 }],
    });
    const http = new HttpClient('apple', { fetch, retries: 2, retryDelayMs: 0 });
    await expect(
      http.send({ method: 'GET', url: 'https://x.test/', retry: true }),
    ).resolves.toMatchObject({ status: 429 });
    expect(fetch.calls).toHaveLength(1);
  });

  it('ignores a non-numeric Retry-After and uses backoff', async () => {
    const fetch = fakeFetch({
      'GET https://x.test/': [
        { status: 503, headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } },
        { status: 200 },
      ],
    });
    const http = new HttpClient('apple', { fetch, retries: 1, retryDelayMs: 0 });
    await expect(
      http.send({ method: 'GET', url: 'https://x.test/', retry: true }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('logs method, redacted URL, status and duration only', async () => {
    const logs: Parameters<typeof recordingLogger>[0] = [];
    const fetch = fakeFetch({ [`GET ${URL_.split('?')[0]}`]: { status: 200, body: {} } });
    const http = new HttpClient('google', { fetch }, recordingLogger(logs));
    await http.send({
      method: 'GET',
      url: URL_,
      headers: { Authorization: 'Bearer ya29.secret' },
      retry: false,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.context).toMatchObject({
      platform: 'google',
      method: 'GET',
      url: 'https://api.example.test/applications/p/purchases/subscriptionsv2/tokens/[redacted]',
      status: 200,
    });
    const text = JSON.stringify(logs);
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain('ya29');
    expect(text).not.toContain('key=abc');
  });

  it('redactUrl masks tokens before :acknowledge and drops the query', () => {
    expect(redactUrl('https://x/p/tokens/abc:acknowledge?x=1')).toBe(
      'https://x/p/tokens/[redacted]:acknowledge',
    );
    expect(redactUrl('https://x/inApps/v1/transactions/1')).toBe(
      'https://x/inApps/v1/transactions/1',
    );
  });

  it('uses global fetch by default', () => {
    expect(() => new HttpClient('apple')).not.toThrow();
  });
});
