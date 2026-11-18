import type { FetchLike } from '../../src/index.js';

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  /** Parsed JSON body, if any. */
  json: unknown;
}

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;
export type Handler = Reply | Reply[] | ((call: RecordedCall) => Reply | Promise<Reply>);

/**
 * Route-based fake fetch. Routes are `"METHOD url"` (query string ignored). An array replies
 * in order; a function computes the reply; an `Error` simulates a network failure.
 */
export function fakeFetch(routes: Record<string, Handler> = {}) {
  const table = new Map<string, Handler>(Object.entries(routes));
  const calls: RecordedCall[] = [];

  const fn: FetchLike = async (input, init) => {
    const headers = { ...(init.headers as Record<string, string>) };
    const body = typeof init.body === 'string' ? init.body : undefined;
    let json: unknown;
    try {
      json = body === undefined ? undefined : JSON.parse(body);
    } catch {
      json = undefined;
    }
    const call: RecordedCall = { method: init.method ?? 'GET', url: input, headers, body, json };
    calls.push(call);
    const key = `${call.method} ${input.split('?')[0]}`;
    const handler = table.get(key);
    if (handler === undefined) throw new Error(`Unexpected request: ${key}`);
    let reply: Reply | undefined;
    if (typeof handler === 'function') reply = await handler(call);
    else if (Array.isArray(handler)) reply = handler.shift();
    else reply = handler;
    if (reply === undefined) throw new Error(`No more replies for ${key}`);
    if (reply instanceof Error) throw reply;
    const text =
      reply.body === undefined
        ? ''
        : typeof reply.body === 'string'
          ? reply.body
          : JSON.stringify(reply.body);
    const nullBody = [204, 205, 304].includes(reply.status);
    return new Response(nullBody ? null : text, {
      status: reply.status,
      headers: reply.headers ?? {},
    });
  };

  return Object.assign(fn, {
    calls,
    route(key: string, handler: Handler) {
      table.set(key, handler);
    },
    callsTo(fragment: string) {
      return calls.filter((call) => `${call.method} ${call.url}`.includes(fragment));
    },
  });
}

export type FakeFetch = ReturnType<typeof fakeFetch>;
