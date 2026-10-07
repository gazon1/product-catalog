import { describe, expect, it } from 'vitest';
import {
  kopecksToRubles,
  rublesToKopecks,
  toNumber,
  discountPercent,
  effectivePriceKopecks,
} from '@/lib/money';

describe('toNumber', () => {
  it('accepts the strings pg returns for int8 and numeric', () => {
    // This is the reason the helper exists: node-postgres never guesses a JS
    // number for these column types, so every money value arrives as a string.
    expect(toNumber('199900')).toBe(199900);
    expect(toNumber('12.34')).toBe(12.34);
    expect(toNumber(0)).toBe(0);
  });

  it('maps absent and unparseable values to null rather than NaN', () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber(undefined)).toBeNull();
    expect(toNumber('не число')).toBeNull();
    expect(toNumber('')).toBeNull();
  });

  it('rejects infinities', () => {
    // A price of Infinity would render as "∞ ₽" and sort to the top of every
    // "cheapest first" list.
    expect(toNumber('Infinity')).toBeNull();
    expect(toNumber('-Infinity')).toBeNull();
  });
});

describe('kopecksToRubles', () => {
  it('converts exactly, without floating point drift', () => {
    expect(kopecksToRubles(199900)).toBe(1999);
    expect(kopecksToRubles(1)).toBe(0.01);
    expect(kopecksToRubles('0.05')).toBeCloseTo(0.0005, 6);
    expect(kopecksToRubles(123456789)).toBe(1234567.89);
  });

  it('round-trips with rublesToKopecks', () => {
    for (const value of [0, 1, 99, 199900, 123456789]) {
      expect(rublesToKopecks(kopecksToRubles(value))).toBe(value);
    }
  });

  it('propagates null', () => {
    expect(kopecksToRubles(null)).toBeNull();
  });
});

describe('discountPercent', () => {
  it('computes the discount off the list price', () => {
    expect(discountPercent(100000, 75000)).toBe(25);
    expect(discountPercent(100000, 50000)).toBe(50);
  });

  it('returns null instead of 0 when there is nothing to compare', () => {
    // A card showing "0%" for a product whose sale price the crawler never
    // recorded is claiming a fact it does not have.
    expect(discountPercent(null, 75000)).toBeNull();
    expect(discountPercent(100000, null)).toBeNull();
    expect(discountPercent(0, 0)).toBeNull();
    expect(discountPercent(100000, null as unknown as number)).toBeNull();
  });

  it('returns null when the "sale" price is not actually lower', () => {
    // The crawler can record a sale price above the base price when a merchant
    // raises the base price but the cached sale price is stale. That is not a
    // negative discount to display.
    expect(discountPercent(100000, 120000)).toBeNull();
    expect(discountPercent(100000, 100000)).toBeNull();
  });
});

describe('effectivePriceKopecks', () => {
  it('prefers a positive sale price', () => {
    expect(effectivePriceKopecks(100000, 75000)).toBe(75000);
    expect(effectivePriceKopecks(100000, null)).toBe(100000);
  });

  it('ignores a zero sale price', () => {
    // 0 is not "free" here — it is a placeholder from a parse that found no
    // price, and displaying "0 ₽" for a product is worse than showing its price.
    expect(effectivePriceKopecks(100000, 0)).toBe(100000);
  });

  it('returns null when neither price is known', () => {
    expect(effectivePriceKopecks(null, null)).toBeNull();
  });
});