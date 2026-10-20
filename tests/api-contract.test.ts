/**
 * The catalog contract, tested against the crawler's own container.
 *
 * ## The gap this closes
 *
 * The other tests are pure: money arithmetic, slug transliteration,
 * query-string parsing, static architecture assertions, and the HTTP client
 * with a stubbed `fetch`. Not one of them opens a socket to a crawler. So
 * nothing here had ever executed the storefront's real read path against a
 * real crawler, and the contract between the two repositories was a document
 * that both sides read and neither side checked.
 *
 * The old suite had the same shape — a database instead of a crawler — and it
 * found three live bugs in `src/lib/queries.ts`: `listTopDeals` filtered by an
 * alias that did not exist, `DISTINCT ON` broke the cashback order, and a
 * non-UUID in a URL produced a database error instead of a 404. Each of them
 * was invisible to a unit test and obvious against a running server.
 *
 * ## What is under test
 *
 * The production functions themselves — `listItems`, `getProduct`,
 * `listTopDeals`, `listTargets`, `getSiteStats` — imported from
 * `@/lib/queries`. Not a copy of their requests. A test that re-implements the
 * call validates the re-implementation, and the previous solution's tests did
 * exactly that: they re-wrote the INSERT against a SQLite schema without
 * foreign keys, so they could never have caught a PostgreSQL typing error.
 *
 * ## The storefront applies no SQL
 *
 * The crawler container migrates and seeds itself. The storefront brings no
 * migration, no seed and no schema copy — that is the whole point of the
 * change, and a test that applied SQL here would have kept the coupling this
 * suite exists to remove.
 *
 * ## The image is checked, not assumed
 *
 * The run resolves the pinned image reference to an image id and compares it
 * with the id of the image the container it started actually runs. A test that
 * silently ran against some other local tag would prove nothing about the
 * image the pin names.
 *
 * ## A missing crawler is a failure, not a skip
 *
 * When the image is not there, this file fails with a message that says which
 * image is missing and how to provide it. It does not skip: a green suite that
 * verified nothing is the exact defect this repository works against.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { apiGet, apiGetText } from '@/lib/api/client';
import {
  PRODUCT_CARD_FIELDS,
  PRODUCT_DETAIL_FIELDS,
  TARGET_SUMMARY_FIELDS,
  type FieldDescriptor,
} from '@/lib/api/types';
import { SORT_ORDERS } from '@/lib/api/sort';
import { buildItemsQuery, normalizePaging } from '@/lib/api/params';
import { MAX_OFFSET } from '@/lib/api/sort';
import {
  getProduct,
  getSiteStats,
  listItems,
  listTargets,
  listTopDeals,
} from '@/lib/queries';
import { MAX_PAGE_SIZE } from '@/lib/types';
import { buildValidator } from './global-setup';

/** What the global setup hands over to the workers. */
interface ContractEnvironment {
  apiUrl: string | null;
  apiKey: string | null;
  image: string | null;
  imageId: string | null;
  containerId: string | null;
  postgresUri: string | null;
  error: string | null;
}

/**
 * Find the hand-over file.
 *
 * By modification time, not by name: a run that was interrupted leaves its
 * directory behind, and picking a stale one means talking to a container that
 * has already been stopped — so the suite fails against a crawler that was
 * working perfectly well a moment earlier.
 */
function findContractFile(): string | null {
  const dirs = readdirSync(tmpdir()).filter((n) => n.startsWith('product-catalog-contract-'));
  const withFiles = dirs
    .map((dir) => join(tmpdir(), dir, 'contract.json'))
    .filter((candidate) => existsSync(candidate))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return withFiles[0] ?? null;
}

let environment: ContractEnvironment;

/**
 * The environment is prepared per test, not once per file.
 *
 * A `beforeAll` that throws leaves the tests of the file *skipped*, and a
 * skipped test is a test that verified nothing — which is the exact thing
 * this repository refuses to accept. A `beforeEach` that throws makes every
 * test fail, with the message that says what is missing and how to provide it.
 */
beforeEach(() => {
  const file = findContractFile();
  if (file === null) {
    throw new Error(
      'no contract environment file. The global setup either did not run or failed before ' +
        'it could hand over the crawler — failing here rather than letting the suite run ' +
        'without a crawler.',
    );
  }

  environment = JSON.parse(readFileSync(file, 'utf8')) as ContractEnvironment;

  if (environment.error) {
    throw new Error(environment.error);
  }
  if (!environment.apiUrl || !environment.apiKey) {
    throw new Error('the contract environment file carries no usable base URL or key.');
  }

  // The client reads the environment at call time, which is what lets a test
  // point the *production* functions at a container.
  process.env.CRAWLER_API_URL = environment.apiUrl;
  process.env.CRAWLER_API_KEY = environment.apiKey;
});

/** The id the pinned reference resolves to right now. */
function pinnedImageId(): string {
  return execFileSync('docker', ['image', 'inspect', environment.image!, '--format', '{{.Id}}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** The id of the image the running container was started from. */
function runningImageId(): string {
  return execFileSync('docker', ['inspect', environment.containerId!, '--format', '{{.Image}}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** The price a card is displayed with: the sale price when there is one. */
function effectivePriceKopecks(item: { priceKopecks: number | null; salePriceKopecks: number | null }): number | null {
  if (item.salePriceKopecks !== null && item.salePriceKopecks > 0) return item.salePriceKopecks;
  return item.priceKopecks;
}

/** Everything a search looks at. */
function haystack(item: { title: string; brand: string | null; seller: string | null }): string {
  return `${item.title} ${item.brand ?? ''} ${item.seller ?? ''}`.toLowerCase();
}

/** The properties a contract schema declares, as the site mirrors them. */
function contractFields(schema: unknown): FieldDescriptor[] {
  const properties = (schema as { properties?: Record<string, { type?: unknown }> }).properties ?? {};
  return Object.entries(properties).map(([name, property]) => {
    const declared = property.type;
    const types = Array.isArray(declared) ? declared : [declared];
    const nullable = types.includes('null');
    const base = types.find((t) => t !== 'null') ?? 'string';
    return { name, type: base, nullable } as FieldDescriptor;
  });
}

describe('the image the run used is the pinned one', () => {
  it('runs the image the pin names', () => {
    // Without this, the whole file could be green against an image that has
    // nothing to do with the one the pin names.
    expect(runningImageId()).toBe(pinnedImageId());
  });

  it('runs the image the run recorded', () => {
    expect(runningImageId()).toBe(environment.imageId);
  });
});

describe('the card shape', () => {
  it('answers with exactly the fields the contract declares', async () => {
    const page = await listItems({ paging: { page: 0, pageSize: 10 } });
    expect(page.items.length).toBeGreaterThan(0);

    for (const item of page.items) {
      const names = Object.keys(item).sort();
      expect(names).toEqual([...PRODUCT_CARD_FIELDS.map((f) => f.name)].sort());
    }
  });

  it('answers with the types the contract declares', async () => {
    const page = await listItems({ paging: { page: 0, pageSize: 25 } });

    for (const item of page.items) {
      for (const field of PRODUCT_CARD_FIELDS) {
        const value = (item as unknown as Record<string, unknown>)[field.name];
        if (value === null) {
          expect(field.nullable, `${field.name} is null but the contract does not allow it`).toBe(
            true,
          );
          continue;
        }
        if (field.type === 'string') expect(typeof value, field.name).toBe('string');
        if (field.type === 'boolean') expect(typeof value, field.name).toBe('boolean');
        if (field.type === 'number') expect(typeof value, field.name).toBe('number');
        if (field.type === 'integer') {
          expect(typeof value, field.name).toBe('number');
          expect(Number.isInteger(value), `${field.name} is not a whole number`).toBe(true);
        }
      }
    }
  });

  it('never answers an empty title', async () => {
    // A card without a title cannot be rendered as a link.
    const page = await listItems({ paging: { page: 0, pageSize: 30 } });
    for (const item of page.items) {
      expect(item.title.trim().length).toBeGreaterThan(0);
      expect(item.productUrl).toMatch(/^https?:\/\//);
      expect(item.scrapedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('keeps the prices in whole kopecks', async () => {
    const page = await listItems({ paging: { page: 0, pageSize: 30 } });
    for (const item of page.items) {
      if (item.priceKopecks !== null) expect(Number.isInteger(item.priceKopecks)).toBe(true);
      if (item.salePriceKopecks !== null) expect(Number.isInteger(item.salePriceKopecks)).toBe(true);
    }
  });
});

describe('pagination', () => {
  it('does not repeat or drop an item across pages', async () => {
    const first = await listItems({ paging: { page: 0, pageSize: 20 } });
    const second = await listItems({ paging: { page: 1, pageSize: 20 } });

    const firstIds = new Set(first.items.map((i) => i.id));
    expect(second.items).toHaveLength(20);
    for (const item of second.items) {
      expect(firstIds.has(item.id), `page 2 repeated ${item.id}`).toBe(false);
    }
  });

  it('reports a total that matches reality', async () => {
    const pageSize = 60;
    const first = await listItems({ paging: { page: 0, pageSize } });

    const seen = new Set<string>();
    let collected = 0;
    for (let page = 0; page < first.totalPages; page += 1) {
      const current = await listItems({ paging: { page, pageSize } });
      for (const item of current.items) {
        expect(seen.has(item.id), `the same item came back twice: ${item.id}`).toBe(false);
        seen.add(item.id);
        collected += 1;
      }
    }

    expect(collected).toBe(first.totalCount);
    expect(first.totalPages).toBe(Math.ceil(first.totalCount / pageSize));
  });

  it('clamps hostile paging instead of failing', async () => {
    const page = await listItems({ paging: { page: -5, pageSize: 100_000 } });
    expect(page.page).toBe(0);
    expect(page.pageSize).toBe(MAX_PAGE_SIZE);
    expect(page.items.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });

  it('never sends a page the API would reject', async () => {
    // The API clamps a hostile page into the range it serves — the contract says
    // so, and `400` is reserved for a parameter the API cannot interpret at all
    // (an id that is not a UUID, a sort order that is not in the list).
    //
    // The site's own clamping is still what keeps an ordinary URL from asking
    // for a page that does not exist, and the two have to agree: this asserts
    // that they do.
    const body = await apiGet<{ page: number; pageSize: number }>('/items', {
      query: new URLSearchParams({ page: '-1', pageSize: '24' }),
    });
    expect(body.page).toBe(0);
    expect(body.pageSize).toBe(24);

    // And the site's own builder never sends the hostile value in the first place.
    expect(buildItemsQuery({ paging: { page: -5, pageSize: 24 } }).get('page')).toBe('0');
  });

  it('clamps a deep page by the offset, not by the page index', async () => {
    // The bound is on the offset — `page x pageSize` — because that is what the
    // database pays for: it walks every row before the page. A deep page is
    // therefore clamped to the last page that fits, and answered with that
    // page's rows rather than with an error.
    //
    // The site clamps to the same number, from the same contract: a storefront
    // that clamped to a different page than the API serves would show a page
    // the API never sent.
    const pageSize = 60;
    const expected = Math.floor(MAX_OFFSET / pageSize);

    const body = await apiGet<{ page: number; pageSize: number }>('/items', {
      query: new URLSearchParams({ page: '99999999', pageSize: String(pageSize) }),
    });
    expect(body.page).toBe(expected);
    expect(body.page * body.pageSize).toBeLessThanOrEqual(MAX_OFFSET);

    // The site's own clamp agrees with the API's answer.
    const site = normalizePaging(99_999_999, pageSize);
    expect(site.page).toBe(body.page);
    expect(buildItemsQuery({ paging: { page: 99_999_999, pageSize } }).get('page')).toBe(
      String(expected),
    );
  });
});

describe('sorting', () => {
  it('sorts by cashback descending when asked', async () => {
    const page = await listItems({ sort: 'CashbackPercentDesc', paging: { page: 0, pageSize: 30 } });
    const percents = page.items
      .map((i) => i.cashbackPercent)
      .filter((v): v is number => v !== null);

    expect(percents.length).toBeGreaterThan(0);
    for (let i = 1; i < percents.length; i += 1) {
      expect(percents[i]!).toBeLessThanOrEqual(percents[i - 1]!);
    }
  });
});

describe('search', () => {
  it('finds a product by a word of its title', async () => {
    const all = await listItems({ paging: { page: 0, pageSize: 30 } });
    const word = all.items
      .flatMap((item) => item.title.split(/\s+/))
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
      .find((w) => w.length >= 4);

    expect(word, 'the catalog should contain a product with a word in its title').toBeDefined();

    const page = await listItems({ filter: { search: word! }, paging: { page: 0, pageSize: 30 } });
    expect(page.totalCount).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(haystack(item)).toContain(word!.toLowerCase());
    }
  });

  it('treats % and _ as literal characters', async () => {
    // Unescaped, `%` matches anything and `_` matches one character, so the
    // search would degenerate into "return everything".
    const all = await listItems({ paging: { page: 0, pageSize: 30 } });
    const word = all.items
      .flatMap((item) => item.title.split(/\s+/))
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
      .find((w) => w.length >= 4);
    expect(word).toBeDefined();

    const literal = await listItems({ filter: { search: `${word!}%` }, paging: { page: 0, pageSize: 30 } });
    const plain = await listItems({ filter: { search: word! }, paging: { page: 0, pageSize: 30 } });

    expect(literal.totalCount).toBeLessThanOrEqual(plain.totalCount);
    for (const item of literal.items) {
      expect(haystack(item)).toContain(`${word!.toLowerCase()}%`);
    }

    const underscore = await listItems({ filter: { search: '_' }, paging: { page: 0, pageSize: 30 } });
    for (const item of underscore.items) {
      expect(haystack(item)).toContain('_');
    }
  });
});

describe('the price filters', () => {
  it('applies the bounds in rubles against the effective price', async () => {
    const page = await listItems({
      filter: { minPriceRubles: 100 },
      paging: { page: 0, pageSize: 40 },
    });

    for (const item of page.items) {
      const effective = effectivePriceKopecks(item);
      if (effective !== null) {
        expect(effective / 100, `${item.title} is cheaper than the bound`).toBeGreaterThanOrEqual(100);
      }
    }
  });

  it('applies an upper bound in rubles too', async () => {
    const page = await listItems({
      filter: { maxPriceRubles: 50 },
      paging: { page: 0, pageSize: 40 },
    });

    for (const item of page.items) {
      const effective = effectivePriceKopecks(item);
      if (effective !== null) {
        expect(effective / 100, `${item.title} is dearer than the bound`).toBeLessThanOrEqual(50);
      }
    }
  });

  it('never claims a cashback larger than the product', async () => {
    // The crawler stores the cashback in rubles and the price in kopecks.
    // Reading one as the other shows up as a seven-figure cashback on a
    // 40 000 ₽ kettle.
    const page = await listItems({
      filter: { minCashbackPercent: 1 },
      sort: 'CashbackPercentDesc',
      paging: { page: 0, pageSize: 25 },
    });

    for (const item of page.items) {
      expect(item.cashbackPercent).not.toBeNull();
      if (item.cashbackRubles !== null) {
        const price = effectivePriceKopecks(item);
        expect(item.cashbackRubles).toBeLessThanOrEqual((price ?? Infinity) / 100);
      }
    }
  });
});

describe('the product page', () => {
  it('returns a product with its price history, newest first', async () => {
    const targets = await listTargets();

    // Find a product that was observed more than once. Where such a product
    // sits is the crawler's business: its observations are spread over the
    // pages they were observed on, and the target that holds them is not
    // necessarily the first one by name.
    let idOf: string | undefined;
    for (const target of targets) {
      const counts = new Map<string, number>();
      const ids = new Map<string, string>();
      for (let page = 0; ; page += 1) {
        const chunk = await listItems({ targetId: target.id, paging: { page, pageSize: 60 } });
        for (const item of chunk.items) {
          const seen = (counts.get(item.title) ?? 0) + 1;
          counts.set(item.title, seen);
          if (!ids.has(item.title)) ids.set(item.title, item.id);
          if (seen > 1) {
            idOf = ids.get(item.title);
            break;
          }
        }
        if (idOf !== undefined || chunk.items.length < 60) break;
      }
      if (idOf !== undefined) break;
    }

    expect(idOf, 'the catalog should contain a product with several observations').toBeDefined();

    const product = await getProduct(idOf!);
    expect(product).not.toBeNull();
    expect(product!.history.length).toBeGreaterThan(1);

    for (let i = 1; i < product!.history.length; i += 1) {
      expect(product!.history[i]!.scrapedAt <= product!.history[i - 1]!.scrapedAt).toBe(true);
    }
  });

  it('does not mix a product’s history across targets', async () => {
    const targets = await listTargets();

    // How many observations of each title each target holds. A product that
    // appears in two targets is the interesting case: a history that crossed
    // the boundary would be longer than the target's own observations.
    const perTarget = new Map<string, Map<string, number>>();
    const itemOf = new Map<string, Map<string, string>>();
    for (const target of targets) {
      const counts = new Map<string, number>();
      const ids = new Map<string, string>();
      for (let page = 0; ; page += 1) {
        const chunk = await listItems({ targetId: target.id, paging: { page, pageSize: 60 } });
        for (const item of chunk.items) {
          counts.set(item.title, (counts.get(item.title) ?? 0) + 1);
          if (!ids.has(item.title)) ids.set(item.title, item.id);
        }
        if (chunk.items.length < 60) break;
      }
      perTarget.set(target.id, counts);
      itemOf.set(target.id, ids);
    }

    let checked = false;
    for (const target of targets) {
      const counts = perTarget.get(target.id)!;
      for (const [title, count] of counts) {
        if (count < 2) continue;

        const elsewhere = targets.filter((other) => (perTarget.get(other.id)!.get(title) ?? 0) > 0);
        if (elsewhere.length < 2) continue;

        // The item is taken from the scan above rather than from a fresh first
        // page: where the product sits in the order is the crawler's business,
        // and a product observed several times is not necessarily on page one.
        const itemId = itemOf.get(target.id)!.get(title)!;
        const product = await getProduct(itemId);
        expect(product).not.toBeNull();
        expect(
          product!.history.length,
          'the history holds observations from another target',
        ).toBe(count);
        checked = true;
        break;
      }
      if (checked) break;
    }

    expect(
      checked,
      'the catalog should contain a product that appears in more than one target',
    ).toBe(true);
  });

  it('returns null for an unknown id', async () => {
    expect(await getProduct('00000000-0000-4000-a000-000000000000')).toBeNull();
  });

  it('returns null for a malformed id instead of throwing', async () => {
    // The id comes straight from the URL.
    await expect(getProduct('not-a-uuid')).resolves.toBeNull();
  });
});

describe('top deals', () => {
  it('returns one row per product, ordered by cashback', async () => {
    const page = await listTopDeals({ paging: { page: 0, pageSize: 30 } });
    expect(page.items.length).toBeGreaterThan(0);

    const seen = new Set<string>();
    for (const item of page.items) {
      expect(seen.has(item.id), `duplicate product ${item.id}`).toBe(false);
      seen.add(item.id);
    }

    // The null cashbacks are left out: where a null sorts is the crawler's
    // business, and a comparison against null is a comparison about nothing.
    const percents = page.items
      .map((i) => i.cashbackPercent)
      .filter((v): v is number => v !== null);
    for (let i = 1; i < percents.length; i += 1) {
      expect(percents[i]!).toBeLessThanOrEqual(percents[i - 1]!);
    }
  });

  it('honours the minimum cashback filter', async () => {
    const page = await listTopDeals({ minCashbackPercent: 15, paging: { page: 0, pageSize: 20 } });
    for (const item of page.items) {
      expect(item.cashbackPercent!).toBeGreaterThanOrEqual(15);
    }
  });
});

describe('the targets and the counters', () => {
  it('counts every item and never exceeds the total', async () => {
    const targets = await listTargets();
    const stats = await getSiteStats();

    expect(targets).toHaveLength(stats.totalTargets);
    for (const target of targets) {
      expect(target.itemCount).toBeGreaterThanOrEqual(0);
    }
    expect(targets.reduce((sum, t) => sum + t.itemCount, 0)).toBe(stats.totalItems);
  });

  it('lists a configured but empty target', async () => {
    const targets = await listTargets();
    const empty = targets.find((t) => t.itemCount === 0);
    expect(empty, 'the catalog should contain one configured-but-empty target').toBeDefined();
  });

  it('answers a target with no items with an empty page', async () => {
    const targets = await listTargets();
    const empty = targets.find((t) => t.itemCount === 0)!;
    const page = await listItems({ targetId: empty.id, paging: { page: 0, pageSize: 24 } });
    expect(page.totalCount).toBe(0);
    expect(page.items).toEqual([]);
  });
});

describe('the nullable fields', () => {
  it('exercises every field the contract allows to be null', async () => {
    const targets = await listTargets();
    const seenNull = new Set<string>();

    const nullable = PRODUCT_CARD_FIELDS.filter((field) => field.nullable).map((field) => field.name);
    for (const target of targets) {
      for (let page = 0; page < 5; page += 1) {
        const chunk = await listItems({ targetId: target.id, paging: { page, pageSize: 60 } });
        for (const item of chunk.items) {
          for (const field of nullable) {
            if ((item as unknown as Record<string, unknown>)[field] === null) seenNull.add(field);
          }
        }
        if (chunk.items.length < 60) break;
      }
    }

    for (const field of nullable) {
      expect(
        seenNull.has(field),
        `the contract allows "${field}" to be null, but no answer in the catalog ever returned one`,
      ).toBe(true);
    }
  });
});

describe('the contract document', () => {
  it('is served by the running crawler', async () => {
    const text = await apiGetText('/contract');
    const document = parse(text) as { openapi?: string; paths?: Record<string, unknown> };
    expect(document.openapi).toBe('3.1.0');
    expect(document.paths).toBeDefined();
  });

  it('describes the card exactly as the site mirrors it', async () => {
    const document = parse(await apiGetText('/contract')) as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const declared = contractFields(document.components.schemas.ProductCard);

    expect(declared.map((f) => f.name).sort()).toEqual(
      PRODUCT_CARD_FIELDS.map((f) => f.name).sort(),
    );
    for (const field of declared) {
      const mirror = PRODUCT_CARD_FIELDS.find((f) => f.name === field.name)!;
      expect(field.type, `${field.name} has another type in the contract`).toBe(mirror.type);
      expect(field.nullable, `${field.name} has another nullability in the contract`).toBe(
        mirror.nullable,
      );
    }
  });

  it('describes the detail as the card plus a history', async () => {
    const document = parse(await apiGetText('/contract')) as {
      components: { schemas: Record<string, { allOf?: Array<{ $ref?: string; properties?: Record<string, unknown> }> }> };
    };
    const allOf = document.components.schemas.ProductDetail?.allOf ?? [];
    const own = allOf.flatMap((part) => Object.keys(part.properties ?? {}));
    expect(own).toEqual(['history']);

    expect(PRODUCT_DETAIL_FIELDS.map((f) => f.name)).toEqual([
      ...PRODUCT_CARD_FIELDS.map((f) => f.name),
      'history',
    ]);
  });

  it('declares exactly the sort names the site sends', async () => {
    const document = parse(await apiGetText('/contract')) as {
      paths: Record<string, { get: { parameters: Array<{ name: string; schema: { enum?: string[] } }> } }>;
    };
    const parameter = document.paths['/items']!.get.parameters.find((p) => p.name === 'sort');
    expect(parameter?.schema.enum?.slice().sort()).toEqual([...SORT_ORDERS].sort());
  });

  it('validates every live answer against it', async () => {
    const document = parse(await apiGetText('/contract'));

    const card = buildValidator(document, 'ProductCard');
    const paged = buildValidator(document, 'PagedProductCard');
    const detail = buildValidator(document, 'ProductDetail');
    const target = buildValidator(document, 'TargetSummary');
    const stats = buildValidator(document, 'SiteStats');

    const page = await listItems({ paging: { page: 0, pageSize: 10 } });
    expect(paged(page), JSON.stringify(paged.errors)).toBe(true);
    for (const item of page.items) {
      expect(card(item), JSON.stringify(card.errors)).toBe(true);
    }

    const product = await getProduct(page.items[0]!.id);
    expect(product).not.toBeNull();
    expect(detail(product), JSON.stringify(detail.errors)).toBe(true);

    const targets = await listTargets();
    for (const summary of targets) {
      expect(target(summary), JSON.stringify(target.errors)).toBe(true);
    }

    const counters = await getSiteStats();
    expect(stats(counters), JSON.stringify(stats.errors)).toBe(true);
  });
});
