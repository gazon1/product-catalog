/**
 * Reading `searchParams` safely.
 *
 * Next 15 hands a page its `params`/`searchParams` as a Promise, and every value
 * in it is `string | string[] | undefined` — a repeated query parameter arrives
 * as an array. Every page in this app goes through these helpers rather than
 * casting inline, because the alternative is a `Number(array)` that quietly
 * yields `NaN` and a page numbered "NaN".
 */

export type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** A trimmed, length-capped string. Empty/absent values become `undefined`. */
export function readString(params: SearchParams, key: string, maxLength = 200): string | undefined {
  const raw = first(params[key]);
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, maxLength);
}

/** A finite number, or `undefined`. Rejects `NaN`, `Infinity` and `1e999`. */
export function readNumber(params: SearchParams, key: string): number | undefined {
  const raw = readString(params, key, 64);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** A non-negative number, or `undefined` — a negative price is not a filter, it is noise. */
export function readNonNegativeNumber(params: SearchParams, key: string): number | undefined {
  const n = readNumber(params, key);
  return n !== undefined && n >= 0 ? n : undefined;
}

export function readFlag(params: SearchParams, key: string): boolean {
  const raw = readString(params, key, 8);
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export async function readParams(
  source: Promise<SearchParams> | SearchParams
): Promise<SearchParams> {
  return await source;
}