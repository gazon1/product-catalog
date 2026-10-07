import { describe, expect, it } from 'vitest';
import { buildItemListSql, normalizePaging } from '@/lib/queries';

/**
 * Placeholder numbering in the item query.
 *
 * ## The defect this catches
 *
 * PostgreSQL binds `$n` positionally against the values array. When the filter
 * already consumed `$1` for the target id, LIMIT/OFFSET have to start at the
 * next free index. Numbering them from 1 produced `LIMIT $2 OFFSET $3` next to
 * a filter bound at `$2`, so Postgres received a UUID where it expected an
 * integer and answered 42804 `datatype_mismatch`.
 *
 * It is not a syntax error and not a unit-test failure: every route that omits
 * a target id works, which is exactly the home page. Only a category page
 * against a real database finds it.
 */

interface Parsed {
  filterIndices: number[];
  limitIndex: number | null;
  offsetIndex: number | null;
  distinctIndices: number[];
  maxIndex: number;
  valueCount: number;
}

function parse(text: string, valueCount: number): Parsed {
  const all = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  const limitIndex = /LIMIT \$(\d+)/.exec(text)?.[1];
  const offsetIndex = /OFFSET \$(\d+)/.exec(text)?.[1];
  return {
    filterIndices: all.filter(
      (n) => n !== Number(limitIndex) && n !== Number(offsetIndex)
    ),
    limitIndex: limitIndex ? Number(limitIndex) : null,
    offsetIndex: offsetIndex ? Number(offsetIndex) : null,
    distinctIndices: [...new Set(all)].sort((a, b) => a - b),
    maxIndex: Math.max(...all),
    valueCount,
  };
}

const CASES = [
  { name: 'no filters, no target', options: {} },
  { name: 'target only', options: { targetId: 't-1' } },
  { name: 'search only', options: { filter: { search: 'кофе' } } },
  { name: 'target + search', options: { targetId: 't-1', filter: { search: 'кофе' } } },
  {
    name: 'target + every filter',
    options: {
      targetId: 't-1',
      filter: {
        search: 'x',
        minPriceRubles: 10,
        maxPriceRubles: 100,
        minCashbackPercent: 5,
        inStockOnly: true,
      },
    },
  },
  {
    name: 'no target + every filter',
    options: {
      filter: {
        search: 'x',
        minPriceRubles: 10,
        maxPriceRubles: 100,
        minCashbackPercent: 5,
        inStockOnly: true,
      },
    },
  },
];

describe('every placeholder in the item query is distinct and in range', () => {
  it.each(CASES)('$name', ({ options }) => {
    const { text, values } = buildItemListSql(options);
    const parsed = parse(text, values.length);

    // Reusing one placeholder for several columns is legal and is what the search
    // clause does (`$1 ILIKE … OR $1 ILIKE …`), so distinctness is not the
    // invariant. What matters is that LIMIT/OFFSET do not *share* an index with
    // a filter value, and that numbering has no gaps — Postgres binds positionally,
    // so a skipped index means a bound value nobody reads.
    expect(
      parsed.filterIndices.includes(parsed.limitIndex!),
      `LIMIT $${parsed.limitIndex} collides with a filter parameter in:\n${text}`
    ).toBe(false);
    expect(
      parsed.filterIndices.includes(parsed.offsetIndex!),
      `OFFSET $${parsed.offsetIndex} collides with a filter parameter in:\n${text}`
    ).toBe(false);

    expect(parsed.distinctIndices).toEqual(
      Array.from({ length: parsed.valueCount }, (_, i) => i + 1)
    );
    expect(parsed.maxIndex).toBe(values.length);
  });
});

describe('LIMIT and OFFSET follow the filter, never precede it', () => {
  it.each(CASES)('$name', ({ options }) => {
    const { text, values } = buildItemListSql(options);
    const parsed = parse(text, values.length);

    expect(parsed.limitIndex).not.toBeNull();
    expect(parsed.offsetIndex).toBe(parsed.limitIndex! + 1);

    const highestFilter = Math.max(0, ...parsed.filterIndices);
    expect(parsed.limitIndex!).toBeGreaterThan(highestFilter);

    // The last two values are the paging pair, in that order.
    expect(values[values.length - 2]).toBeDefined();
    expect(values[values.length - 1]).toBeDefined();
  });
});

describe('filters are bound, never interpolated', () => {
  it('keeps a hostile search string out of the SQL text', () => {
    const { text, values } = buildItemListSql({
      filter: { search: "'; DROP TABLE scraped_items; --" },
    });
    expect(text).not.toContain('DROP TABLE');
    expect(text).not.toContain('--');
    // The string survives verbatim as a bound value, with `_` escaped because it
    // is a LIKE wildcard — the escaping is the point, not a mangling.
    expect(values).toContain(`%'; DROP TABLE scraped\\_items; --%`);
  });

  it('escapes LIKE wildcards so a search for "100%" is literal', () => {
    const { values } = buildItemListSql({ filter: { search: '100%_x' } });
    expect(values[0]).toBe('%100\\%\\_x%');
  });
});

describe('normalizePaging', () => {
  it('clamps hostile input', () => {
    expect(normalizePaging(-5, 9999)).toEqual({ page: 0, pageSize: 60 });
    expect(normalizePaging(2.7, 10.9)).toEqual({ page: 2, pageSize: 10 });
    expect(normalizePaging(NaN, NaN)).toEqual({ page: 0, pageSize: 24 });
    expect(normalizePaging(0, 0)).toEqual({ page: 0, pageSize: 1 });
  });
});