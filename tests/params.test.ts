import { describe, expect, it } from 'vitest';
import { readString, readNumber, readNonNegativeNumber, readFlag } from '@/lib/params';

describe('readString', () => {
  it('reads a plain value', () => {
    expect(readString({ q: 'кофеварка' }, 'q')).toBe('кофеварка');
  });

  it('trims and treats empty as absent', () => {
    expect(readString({ q: '  ' }, 'q')).toBeUndefined();
    expect(readString({ q: '' }, 'q')).toBeUndefined();
    expect(readString({ q: '  чайник  ' }, 'q')).toBe('чайник');
  });

  it('takes the first value of a repeated parameter', () => {
    // A repeated ?q=a&q=b arrives as an array; without this the page would call
    // .trim() on an array and throw.
    expect(readString({ q: ['первый', 'второй'] }, 'q')).toBe('первый');
  });

  it('caps length so a huge query string cannot be passed to ILIKE unbounded', () => {
    expect(readString({ q: 'x'.repeat(5000) }, 'q', 200)).toHaveLength(200);
  });

  it('returns undefined for a missing key', () => {
    expect(readString({}, 'q')).toBeUndefined();
  });
});

describe('readNumber', () => {
  it('parses finite numbers', () => {
    expect(readNumber({ page: '3' }, 'page')).toBe(3);
    expect(readNumber({ minPrice: '199.99' }, 'minPrice')).toBeCloseTo(199.99);
  });

  it('rejects NaN and Infinity instead of propagating them', () => {
    // Number('abc') is NaN, and a NaN page number reaches normalizePaging,
    // LIMIT/OFFSET and the page-number UI all at once.
    expect(readNumber({ page: 'abc' }, 'page')).toBeUndefined();
    expect(readNumber({ page: '1e999' }, 'page')).toBeUndefined();
    expect(readNumber({ page: '   ' }, 'page')).toBeUndefined();
  });

  it('accepts zero', () => {
    expect(readNumber({ page: '0' }, 'page')).toBe(0);
  });
});

describe('readNonNegativeNumber', () => {
  it('rejects negatives', () => {
    // A negative price filter is not a filter, it is noise.
    expect(readNonNegativeNumber({ minPrice: '-100' }, 'minPrice')).toBeUndefined();
    expect(readNonNegativeNumber({ minPrice: '0' }, 'minPrice')).toBe(0);
    expect(readNonNegativeNumber({ minPrice: '100' }, 'minPrice')).toBe(100);
  });
});

describe('readFlag', () => {
  it('accepts the usual truthy spellings', () => {
    expect(readFlag({ inStock: '1' }, 'inStock')).toBe(true);
    expect(readFlag({ inStock: 'true' }, 'inStock')).toBe(true);
    expect(readFlag({ inStock: 'yes' }, 'inStock')).toBe(true);
  });

  it('treats anything else as false', () => {
    expect(readFlag({}, 'inStock')).toBe(false);
    expect(readFlag({ inStock: '0' }, 'inStock')).toBe(false);
    expect(readFlag({ inStock: 'on' }, 'inStock')).toBe(false);
  });
});