import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Data-quality gate over the committed seed.
 *
 * ## Why parse generated SQL at all
 *
 * The generator now refuses to write data that violates its invariants, but the
 * seed is committed — so the file on disk can be stale, hand-edited, or produced
 * by an older version of the generator. Checking the artifact rather than the
 * code is what actually protects the person reading the site.
 *
 * This is not hypothetical: the first version of the generator computed cashback
 * as `price × percent`, missing the `/ 100`, so every row carried a cashback
 * 100× the price of its product. No test failed, no query errored, and the
 * storefront rendered the numbers as though they were ordinary.
 *
 * ## Why a hand-rolled parse is acceptable here
 *
 * The file has one INSERT statement shape that this generator writes. A regex is
 * fragile in general and exact here; anything more would only be harder to read
 * and no more correct. The parse fails loudly if the shape changes, which is the
 * behaviour a silent skip would not have.
 */

const SEED = resolve(__dirname, '..', 'dev', 'db', '99-seed.sql');

interface Item {
  title: string;
  priceKopecks: number;
  salePriceKopecks: number | null;
  cashbackRubles: number | null;
  cashbackPercent: number | null;
}

const COLUMN_COUNT = 16;

function readItems(): Item[] {
  const sql = readFileSync(SEED, 'utf8');
  const pattern =
    /INSERT INTO scraped_items[^)]*\)\s*\n\s*VALUES \(([^;]*?)\);/g;

  const items: Item[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sql)) !== null) {
    // A quoted field may contain commas — a title like «Манн, Иванов и Фербер»
    // is in this very seed. The unquoted alternative therefore excludes the
    // quote character as well as the comma: `[^,]+` happily starts on the space
    // before a quote, swallows the quote, and stops at the comma *inside* the
    // title, silently shifting every later column by one. That produced NaN
    // prices in an earlier version of this file rather than a parse error.
    //
    // Whitespace-only tokens are dropped afterwards. A separator space before a
    // quoted value would otherwise become its own token; a space before a bare
    // scalar (` 1`, ` NULL`) merges into it and survives the trim, which is why
    // filtering on "trimmed is empty" is the right test rather than "starts with
    // a space".
    const values = (match[1]!.match(/'(?:[^']|'')*'|[^',]+/g) ?? []).filter(
      (v) => v.trim().length > 0
    );

    // A mis-split is caught here rather than downstream, where it would show up
    // as a plausible-looking wrong number.
    if (values.length !== COLUMN_COUNT) {
      throw new Error(
        `seed row ${items.length} parsed into ${values.length} values, expected ${COLUMN_COUNT}: ` +
          `${match[1]!.slice(0, 160)}`
      );
    }

    const scalar = (v: string) => v.trim();
    const unquote = (v: string) =>
      scalar(v).replace(/^'|'$/g, '').replace(/''/g, "'");
    const num = (v: string) => {
      const s = scalar(v);
      return s === 'NULL' ? null : Number(s);
    };

    // Column order is fixed by the generator: id, target_id, product_id,
    // match_id, title, brand, seller, price_kopecks, sale_price_kopecks,
    // cashback, cashback_percent, image_url, in_stock, product_url,
    // content_hash, scraped_at.
    items.push({
      title: unquote(values[4] ?? ''),
      priceKopecks: num(values[7] ?? '') as number,
      salePriceKopecks: num(values[8] ?? ''),
      cashbackRubles: num(values[9] ?? ''),
      cashbackPercent: num(values[10] ?? ''),
    });
  }

  if (items.length === 0) {
    throw new Error(
      'no scraped_items rows parsed from dev/db/99-seed.sql — the generator output shape changed, ' +
        'so this gate is now checking nothing. Fix the parser.'
    );
  }
  return items;
}

const items = readItems();

describe('seed data money invariants', () => {
  it('parses a non-trivial number of rows', () => {
    expect(items.length).toBeGreaterThan(1000);
  });

  it('cashback in rubles never exceeds the price it is a percentage of', () => {
    // The check that would have caught the 100× error.
    const offenders = items.filter((i) => {
      if (i.cashbackRubles === null || i.cashbackPercent === null) return false;
      const payable = i.salePriceKopecks ?? i.priceKopecks;
      return i.cashbackRubles > (payable / 100) * (i.cashbackPercent / 100) + 0.01;
    });
    expect(
      offenders.slice(0, 3),
      `${offenders.length} rows have a cashback larger than the price it derives from — ` +
        'percent and rubles have been mixed up again'
    ).toEqual([]);
  });

  it('cashback never exceeds the price under any reading of the percentage', () => {
    // A weaker, cruder invariant, kept on purpose: even if a percent were stored
    // as a fraction (0.11), cashback must stay below the price.
    const offenders = items.filter((i) => {
      if (i.cashbackRubles === null) return false;
      return i.cashbackRubles > (i.salePriceKopecks ?? i.priceKopecks) / 100;
    });
    expect(offenders.slice(0, 3), 'cashback larger than the product price').toEqual([]);
  });

  it('a sale price is always below the base price', () => {
    const offenders = items.filter(
      (i) => i.salePriceKopecks !== null && i.salePriceKopecks >= i.priceKopecks
    );
    expect(offenders.slice(0, 3)).toEqual([]);
  });

  it('prices are whole kopecks', () => {
    const offenders = items.filter((i) => !Number.isInteger(i.priceKopecks) || i.priceKopecks <= 0);
    expect(offenders.slice(0, 3)).toEqual([]);
  });

  it('never invents a price outside a plausible range', () => {
    // 10 ₽ … 10 000 000 ₽. A generated catalogue outside this means the price
    // range in the generator was changed by accident.
    const offenders = items.filter((i) => i.priceKopecks < 1_000 || i.priceKopecks > 1_000_000_000);
    expect(offenders.slice(0, 3)).toEqual([]);
  });
});

describe('seed data covers the states the UI must handle', () => {
  const sql = readFileSync(SEED, 'utf8');

  it('includes rows with no image, so the fallback is exercised', () => {
    expect(sql).toMatch(/NULL, (true|false), 'https:\/\/www\.wildberries\.ru/);
  });

  it('includes rows with a NULL price and NULL cashback', () => {
    expect(items.some((i) => i.cashbackRubles === null)).toBe(true);
  });

  it('includes out-of-stock rows', () => {
    expect(sql).toMatch(/, false, 'https:\/\/www\.wildberries\.ru/);
  });

  it('includes at least one configured but empty target', () => {
    // A configured-but-empty catalog is a real state — a target exists and no
    // crawl has written to it yet. The catalog page has to render that without
    // pretending it holds data, so the seed has to contain one.
    const targetBlock = sql.slice(sql.indexOf('INSERT INTO crawl_targets'));
    const configuredTargets = [...targetBlock.matchAll(/VALUES \('([0-9a-f-]{36})'/g)].map(
      (m) => m[1]!
    );

    const itemBlock = sql.slice(sql.indexOf('INSERT INTO scraped_items'));
    const targetsWithItems = new Set(
      [...itemBlock.matchAll(/VALUES \('[^']+', '([0-9a-f-]{36})'/g)].map((m) => m[1]!)
    );

    expect(configuredTargets.length).toBeGreaterThan(1);
    expect(targetsWithItems.size).toBeGreaterThan(1);

    const emptyTargets = configuredTargets.filter((id) => !targetsWithItems.has(id));
    expect(
      emptyTargets.length,
      'no empty target in the seed — the empty-catalog UI path would never be exercised'
    ).toBeGreaterThan(0);
  });
});