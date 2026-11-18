/** Small runtime guards for untrusted JSON (store payloads, webhook bodies). */

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function obj(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Epoch milliseconds → Date, or null when absent/not numeric. */
export function msDate(value: unknown): Date | null {
  const n = num(value);
  return n === undefined ? null : new Date(n);
}

/** RFC 3339 string → Date, or null when absent/unparseable. */
export function isoDate(value: unknown): Date | null {
  const s = str(value);
  if (s === undefined) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
