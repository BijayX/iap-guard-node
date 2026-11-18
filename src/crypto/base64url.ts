const BASE64URL = /^[A-Za-z0-9_-]*$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function base64urlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Strict base64url decode (no padding, no foreign characters); null when invalid. */
export function base64urlDecode(input: string): Buffer | null {
  if (!BASE64URL.test(input) || input.length % 4 === 1) return null;
  return Buffer.from(input, 'base64url');
}

/** Standard (not url-safe) base64 decode; null when the input has foreign characters. */
export function base64Decode(input: string): Buffer | null {
  const compact = input.replace(/\s+/g, '');
  if (!BASE64.test(compact) || compact.replace(/=+$/, '').length % 4 === 1) return null;
  return Buffer.from(compact, 'base64');
}
