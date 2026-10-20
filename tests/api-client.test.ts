/**
 * The HTTP client, tested without a crawler, a container or a network.
 *
 * ## What is under test
 *
 * The request the client builds and the failures it turns into errors. The
 * client is the one place where a unit mistake becomes a production symptom:
 * a price filter sent in the wrong unit is a filter that silently matches
 * nothing, and an unknown sort name is a `400` on a page a visitor opened.
 *
 * The fetch is stubbed, so the assertions are about *what was sent* — the URL,
 * the query string, the headers — rather than about what came back.
 *
 * ## Why the validator is tested here
 *
 * `tests/api-contract.test.ts` validates the crawler's real answers against
 * the crawler's real contract document. That test is worth exactly as much as
 * the validator behind it: a validator that accepts everything would let a
 * broken answer through and the suite would be green. So the last block of
 * this file attacks the validator itself, with four answers that must be
 * rejected. If the validator stops rejecting them, the contract test has
 * stopped proving anything, and it should fail here first.
 *
 * ## The request id
 *
 * The crawler logs every request under an id and answers with the same id in
 * the `X-Request-Id` header. A failure that does not name that id is a
 * failure an operator cannot look up, so the block below checks both halves
 * of the correlation: the id the site sends, and the id the crawler answered
 * with — including the case where the crawler answered with none at all, and
 * the case where it never answered at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { ApiError, apiGet, CONNECT_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '@/lib/api/client';
import { buildItemsQuery, buildTopDealsQuery } from '@/lib/api/params';
import { SORT_ORDERS } from '@/lib/api/sort';
import { buildValidator, parseContractDocument } from './global-setup';

const API_URL = 'http://crawler.test:8080';
const API_KEY = 'test-key-do-not-log';

/** What the stubbed fetch was called with. */
interface Call {
  url: string;
  init: RequestInit | undefined;
}

let calls: Call[] = [];
let restoreEnv: Array<[string, string | undefined]> = [];

beforeEach(() => {
  calls = [];
  restoreEnv = [];

  for (const [name, value] of [
    ['CRAWLER_API_URL', API_URL],
    ['CRAWLER_API_KEY', API_KEY],
  ] as const) {
    restoreEnv.push([name, process.env[name]]);
    process.env[name] = value;
  }

  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const [name, value] of restoreEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** The query string of the last call, exactly as it went out. */
function lastQuery(): string {
  const call = calls[calls.length - 1];
  expect(call, 'the client did not make a request').toBeDefined();
  return new URL(call!.url).search.replace(/^\?/, '');
}

describe('the client builds the request the contract describes', () => {
  it('puts the path under the contract prefix', async () => {
    await apiGet('/items');
    expect(calls[0]!.url).toBe('http://crawler.test:8080/api/catalog/v1/items');
  });

  it('does not double the prefix when the base URL already carries it', async () => {
    process.env.CRAWLER_API_URL = 'http://crawler.test:8080/api/catalog/v1';
    await apiGet('/targets');
    expect(calls[0]!.url).toBe('http://crawler.test:8080/api/catalog/v1/targets');
  });

  it('sends the query string in a fixed order', async () => {
    await apiGet('/items', {
      query: buildItemsQuery({
        targetId: '11111111-1111-4111-8111-111111111111',
        filter: {
          search: 'чайник',
          minPriceRubles: 100,
          maxPriceRubles: 5000,
          minCashbackPercent: 5,
          inStockOnly: true,
        },
        sort: 'PriceAsc',
        paging: { page: 0, pageSize: 24 },
      }),
    });

    expect(lastQuery()).toBe(
      'targetId=11111111-1111-4111-8111-111111111111&q=%D1%87%D0%B0%D0%B9%D0%BD%D0%B8%D0%BA' +
        '&minPrice=100&maxPrice=5000&minCashback=5&inStock=true&sort=PriceAsc&page=0&pageSize=24',
    );
  });

  it('leaves out the parameters that carry no meaning', async () => {
    // An absent filter is not a filter of zero: `minPrice=0` would ask for the
    // free products, which is a different question from "no minimum".
    await apiGet('/items', { query: buildItemsQuery({}) });

    expect(lastQuery()).toBe('sort=DateDesc&page=0&pageSize=24');
  });

  it('sends minPrice and maxPrice as rubles, unchanged', async () => {
    // The conversion to kopecks happens exactly once, inside the API. A
    // hundred here is a hundred rubles, not ten thousand.
    await apiGet('/items', {
      query: buildItemsQuery({
        filter: { minPriceRubles: 199.99, maxPriceRubles: 1000 },
        paging: { page: 0, pageSize: 24 },
      }),
    });

    const query = new URLSearchParams(lastQuery());
    expect(query.get('minPrice')).toBe('199.99');
    expect(query.get('maxPrice')).toBe('1000');
    expect(lastQuery()).not.toContain('19999');
  });

  it('sends the cashback filter as a percent', async () => {
    await apiGet('/items', {
      query: buildItemsQuery({ filter: { minCashbackPercent: 15 }, paging: { page: 0, pageSize: 24 } }),
    });
    expect(new URLSearchParams(lastQuery()).get('minCashback')).toBe('15');
  });

  it('sends the in-stock filter only when it is on', async () => {
    await apiGet('/items', {
      query: buildItemsQuery({ filter: { inStockOnly: false }, paging: { page: 0, pageSize: 24 } }),
    });
    expect(lastQuery()).not.toContain('inStock');

    await apiGet('/items', {
      query: buildItemsQuery({ filter: { inStockOnly: true }, paging: { page: 0, pageSize: 24 } }),
    });
    expect(new URLSearchParams(lastQuery()).get('inStock')).toBe('true');
  });

  it('never sends a sort the API would reject', async () => {
    // The API answers `400` for a name it does not know, and a `400` on a page
    // a visitor opened is a broken page.
    await apiGet('/items', {
      query: buildItemsQuery({ sort: 'PriceDesc; DROP TABLE items' as never }),
    });
    expect(new URLSearchParams(lastQuery()).get('sort')).toBe('DateDesc');
  });

  it('sends only declared sort names', async () => {
    for (const sort of SORT_ORDERS) {
      await apiGet('/items', { query: buildItemsQuery({ sort }) });
      expect(new URLSearchParams(lastQuery()).get('sort')).toBe(sort);
    }
  });

  it('clamps hostile paging before it travels', async () => {
    await apiGet('/items', {
      query: buildItemsQuery({ paging: { page: -5, pageSize: 100_000 } }),
    });

    const query = new URLSearchParams(lastQuery());
    expect(query.get('page')).toBe('0');
    expect(query.get('pageSize')).toBe('60');
  });

  it('sends the search term verbatim', async () => {
    // `%` and `_` are literal characters in the API's search. Escaping them
    // here would mean the site's SQL dialect leaking into a query string.
    await apiGet('/items', {
      query: buildItemsQuery({ filter: { search: '100%_off' }, paging: { page: 0, pageSize: 24 } }),
    });
    expect(new URLSearchParams(lastQuery()).get('q')).toBe('100%_off');
  });

  it('sends the top-deals query without a sort', async () => {
    await apiGet('/top-deals', {
      query: buildTopDealsQuery({ minCashbackPercent: 15, paging: { page: 1, pageSize: 10 } }),
    });
    expect(lastQuery()).toBe('minCashback=15&page=1&pageSize=10');
  });

  it('sends the key in the X-Api-Key header', async () => {
    await apiGet('/items');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe(API_KEY);
  });

  it('does not put the key in the URL', async () => {
    await apiGet('/items');
    expect(calls[0]!.url).not.toContain(API_KEY);
  });
});

describe('a failed answer becomes an ApiError', () => {
  it('turns a 401 into an ApiError with status 401', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: 'the key does not match' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(apiGet('/items')).rejects.toBeInstanceOf(ApiError);
    await expect(apiGet('/items')).rejects.toMatchObject({ status: 401 });
  });

  it('turns a 5xx into an ApiError with the status', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: 'statement timeout' }), { status: 503 }),
    );

    await expect(apiGet('/items')).rejects.toBeInstanceOf(ApiError);
    await expect(apiGet('/items')).rejects.toMatchObject({ status: 503 });
  });

  it('turns a network failure into an ApiError', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    const error = await apiGet('/items').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toContain('unreachable');
  });

  it('turns a timeout into an ApiError', async () => {
    // A request that never answers: the deadline has to end it, and the
    // failure has to be an ApiError rather than a bare AbortError.
    vi.stubGlobal(
      'fetch',
      (_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );

    const error = await apiGet('/items', { connectTimeoutMs: 20, timeoutMs: 20 }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain('did not answer');
  });

  it('keeps the overall deadline larger than the crawler’s statement timeout', async () => {
    // The crawler gives up on a statement after eight seconds. Our overall
    // deadline has to be larger than that, or a slow query would be cut off
    // here and reported as a network failure instead of the crawler's own
    // "statement timed out".
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(8_000);
    expect(CONNECT_TIMEOUT_MS).toBe(3_000);
  });

  it('never puts the key in the error message', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    const error = (await apiGet('/items').catch((err: unknown) => err)) as ApiError;
    expect(error.message).not.toContain(API_KEY);
  });

  it('never logs the key', async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: 'nope' }), { status: 401 }),
    );
    await apiGet('/items').catch(() => undefined);

    for (const args of logged) {
      expect(args.map((a) => String(a)).join(' ')).not.toContain(API_KEY);
    }
  });

  it('redacts the key out of a message that already carries it', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError(`the proxy rejected ${API_KEY}`);
    });

    const error = (await apiGet('/items').catch((err: unknown) => err)) as ApiError;
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain('[redacted]');
  });
});

/** The id the site sent with the last request. */
function lastRequestId(): string {
  const call = calls[calls.length - 1];
  expect(call, 'the client did not make a request').toBeDefined();
  const headers = call!.init!.headers as Record<string, string>;
  return headers['X-Request-Id']!;
}

/**
 * A fetch stub that records the request and answers with the given response.
 *
 * The recording matters: the id the site sent is only visible on the request
 * that carried it, and a stub that swallows the request hides it.
 */
function stubAnswer(response: Response): void {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    // A fresh copy for every attempt: a body can be read only once, and the client
    // may ask again after a 503 or a timeout.
    return response.clone();
  });
}

/**
 * The id ties a failure to one request in the crawler's log.
 *
 * Without it, "the catalog API answered 503" is a symptom; with it, the
 * operator has the key to the crawler's own record of the request that
 * failed. The two halves are checked separately, because they can disagree:
 * the crawler may answer with an id of its own, and it may answer with none.
 */
describe('one retry, and only where a retry helps', () => {
  it('asks again once after a 503', async () => {
    // A 503 is the crawler saying "the catalog cannot be served right now". The
    // request was well-formed; the moment was not — so asking again is the difference
    // between a page that renders and a page that shows an error.
    let attempt = 0;
    vi.stubGlobal('fetch', async () => {
      attempt += 1;
      if (attempt === 1) return new Response(JSON.stringify({ error: 'not ready' }), { status: 503 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const body = await apiGet<{ ok: boolean }>('/items');
    expect(body.ok).toBe(true);
    expect(attempt).toBe(2);
  });

  it('asks again at most once after a 503', async () => {
    // A retry is a request the caller did not ask for, and it costs the crawler's
    // database a query. One retry turns a single unlucky moment into a page that
    // works; two retries turn a crawler that is down into three times the load.
    let attempt = 0;
    vi.stubGlobal('fetch', async () => {
      attempt += 1;
      return new Response(JSON.stringify({ error: 'not ready' }), { status: 503 });
    });

    await expect(apiGet('/items')).rejects.toMatchObject({ status: 503 });
    expect(attempt).toBe(2);
  });

  it('asks again once after a timeout', async () => {
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      (_input: unknown, init?: RequestInit) => {
        attempt += 1;
        if (attempt === 1) {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          });
        }
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    );

    const body = await apiGet<{ ok: boolean }>('/items', { connectTimeoutMs: 20, timeoutMs: 20 });
    expect(body.ok).toBe(true);
    expect(attempt).toBe(2);
  });

  it('never asks again after a 4xx', async () => {
    // A 4xx is the crawler saying "this request is wrong". The second attempt would be
    // wrong in exactly the same way, and it would double the traffic of whoever is
    // calling with a broken key.
    for (const status of [400, 401, 404, 429]) {
      let attempt = 0;
      vi.stubGlobal('fetch', async () => {
        attempt += 1;
        return new Response(JSON.stringify({ error: 'no' }), { status });
      });

      await expect(apiGet('/items')).rejects.toMatchObject({ status });
      expect(attempt).toBe(1);
    }
  });

  it('never asks again after a network failure', async () => {
    // The crawler is not there, and a second attempt would find it still not there —
    // the caller is better served by an honest error than by a request that waits
    // twice as long to fail the same way.
    let attempt = 0;
    vi.stubGlobal('fetch', async () => {
      attempt += 1;
      throw new TypeError('fetch failed');
    });

    await expect(apiGet('/items')).rejects.toBeInstanceOf(ApiError);
    expect(attempt).toBe(1);
  });

  it('sends a different request id with the second attempt', async () => {
    // The two attempts are two requests, and the crawler's log holds two entries. An
    // id that was the same for both would make them indistinguishable in the log.
    let attempt = 0;
    const ids: Array<string | null | undefined> = [];
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      attempt += 1;
      const headers = new Headers(init?.headers);
      ids.push(headers.get('X-Request-Id'));
      if (attempt === 1) return new Response(JSON.stringify({ error: 'not ready' }), { status: 503 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await apiGet('/items');
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe('the request id', () => {
  it('sends an id of its own with every request', async () => {
    await apiGet('/items');

    const id = lastRequestId();
    expect(id, 'the request carried no X-Request-Id header').toBeTruthy();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('sends a different id for every request', async () => {
    // One id for the whole process would be no id at all: the second failure
    // would point at the first request in the crawler's log.
    await apiGet('/items');
    const first = lastRequestId();

    await apiGet('/items');
    const second = lastRequestId();

    expect(second).not.toBe(first);
  });

  it('names the crawler’s id when the call failed', async () => {
    stubAnswer(
      new Response(JSON.stringify({ error: 'statement timeout' }), {
        status: 503,
        headers: { 'X-Request-Id': 'crawler-log-id' },
      }),
    );

    const error = (await apiGet('/items').catch((err: unknown) => err)) as ApiError;
    expect(error.message).toContain('(request crawler-log-id)');
    expect(error.requestId).toBe('crawler-log-id');
  });

  it('names its own id when the answer carries none', async () => {
    // A crawler that does not send the header is not a reason to lose the
    // correlation: the site's own id is still the id that went out.
    stubAnswer(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));

    const error = (await apiGet('/items').catch((err: unknown) => err)) as ApiError;
    const sent = lastRequestId();

    expect(error.message).toContain(`(request ${sent})`);
    expect(error.message).not.toContain('undefined');
    expect(error.requestId).toBe(sent);
  });

  it('names its own id when the crawler never answered', async () => {
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      throw new TypeError('fetch failed');
    });

    const error = (await apiGet('/items').catch((err: unknown) => err)) as ApiError;
    const sent = lastRequestId();

    expect(error.message).toContain(`(request ${sent})`);
    expect(error.message).not.toContain('undefined');
    expect(error.requestId).toBe(sent);
  });

  it('names its own id when the request timed out', async () => {
    vi.stubGlobal(
      'fetch',
      (input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          calls.push({ url: String(input), init });
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );

    const error = (await apiGet('/items', { connectTimeoutMs: 20, timeoutMs: 20 }).catch(
      (err: unknown) => err,
    )) as ApiError;
    const sent = lastRequestId();

    expect(error.message).toContain(`(request ${sent})`);
    expect(error.requestId).toBe(sent);
  });

  it('never puts the key in the message that carries the id', async () => {
    stubAnswer(
      new Response(JSON.stringify({ error: 'nope' }), {
        status: 401,
        headers: { 'X-Request-Id': 'crawler-log-id' },
      }),
    );

    const error = (await apiGet('/items').catch((err: unknown) => err)) as ApiError;
    expect(error.message).not.toContain(API_KEY);
  });
});

/**
 * The contract document.
 *
 * The storefront deliberately keeps no copy of it: two documents that describe
 * the same shapes are two sources of truth, and the one nobody reads is the
 * one that quietly licenses the next drift. The crawler's own document is
 * authoritative, and it is read from the crawler's checkout — or from wherever
 * `CONTRACT_OPENAPI_PATH` points.
 */
describe('the validator the contract test relies on', () => {
  it('accepts a card that matches the contract', () => {
    // The other way round. A validator that rejects everything would make the
    // contract test look rigorous while proving nothing.
    const document = parseContractDocument();
    const validate = buildValidator(document, 'ProductCard');

    const card = {
      id: '11111111-1111-4111-8111-111111111111',
      targetId: '22222222-2222-4222-8222-222222222222',
      targetName: 'Чайники',
      title: 'Чайник электрический',
      priceKopecks: 199990,
      salePriceKopecks: null,
      brand: 'Brand',
      seller: 'Seller',
      cashbackPercent: 12.5,
      cashbackRubles: 240,
      inStock: true,
      imageUrl: 'https://cdn.example.com/i.png',
      productUrl: 'https://www.wildberries.net/catalog/1/detail.aspx',
      scrapedAt: '2024-05-06T07:08:09Z',
    };

    expect(validate(card), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a price that is not a number', () => {
    const document = parseContractDocument();
    const validate = buildValidator(document, 'ProductCard');

    expect(validate({ priceKopecks: '199990' })).toBe(false);
  });

  it('rejects a card that is missing a required field', () => {
    const document = parseContractDocument();
    const validate = buildValidator(document, 'ProductCard');

    expect(validate({ id: '11111111-1111-4111-8111-111111111111' })).toBe(false);
  });

  it('rejects a timestamp that is not a date-time', () => {
    const document = parseContractDocument();
    const validate = buildValidator(document, 'ProductCard');

    expect(validate({ scrapedAt: 'the day before yesterday' })).toBe(false);
  });

  it('rejects a sort name outside the enum', () => {
    const document = parseContractDocument() as {
      paths: Record<string, { get: { parameters: Array<{ name: string; schema: unknown }> } }>;
    };
    const sortParameter = document.paths['/items']!.get.parameters.find((p) => p.name === 'sort');
    expect(sortParameter, 'the contract must document a sort parameter').toBeDefined();

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(sortParameter!.schema as object);

    expect(validate('PriceDesc')).toBe(true);
    expect(validate('PriceDesc; DROP TABLE items')).toBe(false);
    expect(validate('scraped_at DESC')).toBe(false);
  });
});
