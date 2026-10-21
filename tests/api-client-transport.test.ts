/**
 * Транспорт клиента: как именно витрина спрашивает каталог.
 *
 * ## Что здесь под тестом
 *
 * Одно решение: **как спросить** — по какому адресу, с каким ключом, с каким
 * типом содержимого, в какие сроки и с каким идентификатором запроса.
 *
 * Транспорт — то место, где ошибка единицы превращается в симптом в продакшене:
 * ключ, отправленный не в том заголовке, — это `401` на каждой странице, а
 * слишком короткий дедлайн — это обрыв perfectly good запроса, который краулер
 * был вправе выполнять восемь секунд.
 *
 * ## Почему `fetch` подменён
 *
 * `fetch` подменён рукописной функцией, поэтому утверждения касаются *того, что
 * было отправлено* — URL, строки запроса, заголовков, — а не того, что пришло
 * обратно. Ответ приходит из другой части клиента; здесь он не нужен.
 */

import { describe, expect, it, vi } from 'vitest';
import { apiGet, apiGetText, ApiError, CONNECT_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '@/lib/api/client';
import { API_KEY, useClientHarness } from './api-client-harness';

const harness = useClientHarness();

describe('the client asks the crawler where the contract lives', () => {
  it('puts the path under the contract prefix', async () => {
    await apiGet('/items');
    expect(harness.calls[0]!.url).toBe('http://crawler.test:8080/api/catalog/v1/items');
  });

  it('does not double the prefix when the base URL already carries it', async () => {
    process.env.CRAWLER_API_URL = 'http://crawler.test:8080/api/catalog/v1';
    await apiGet('/targets');
    expect(harness.calls[0]!.url).toBe('http://crawler.test:8080/api/catalog/v1/targets');
  });

  it('says so plainly when the base URL is not set', async () => {
    delete process.env.CRAWLER_API_URL;

    const error = (await apiGet('/items').catch((err: unknown) => err)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('CRAWLER_API_URL is not set');
  });

  it('says so plainly when the key is not set', async () => {
    delete process.env.CRAWLER_API_KEY;

    const error = (await apiGet('/items').catch((err: unknown) => err)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('CRAWLER_API_KEY is not set');
  });
});

describe('the client proves who it is without telling the key to the log', () => {
  it('sends the key in the X-Api-Key header', async () => {
    await apiGet('/items');
    const headers = harness.calls[0]!.init!.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe(API_KEY);
  });

  it('does not put the key in the URL', async () => {
    await apiGet('/items');
    expect(harness.calls[0]!.url).not.toContain(API_KEY);
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

describe('the client says what it expects to get back', () => {
  it('asks for JSON by default', async () => {
    await apiGet('/items');
    const headers = harness.calls[0]!.init!.headers as Record<string, string>;
    expect(headers['Accept']).toBe('application/json');
  });

  it('asks for the contract as YAML when the caller wants text', async () => {
    // Контракт отдаётся в YAML, и клиент, попросивший JSON, получил бы `406` —
    // честный ответ, но не тот, который нужен вызывающему.
    await apiGetText('/contract');
    const headers = harness.calls[0]!.init!.headers as Record<string, string>;
    expect(headers['Accept']).toContain('application/yaml');
  });
});

describe('the client gives the request a deadline', () => {
  it('keeps the overall deadline larger than the crawler’s statement timeout', async () => {
    // Краулер сдаётся на запросе через восемь секунд. Наш общий дедлайн должен
    // быть больше, иначе медленный запрос обрезался бы здесь и выглядел бы как
    // сетевой сбой вместо собственного «statement timed out» краулера.
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(8_000);
    expect(CONNECT_TIMEOUT_MS).toBe(3_000);
  });

  it('turns a timeout into an ApiError', async () => {
    // Запрос, на который не приходит ответа: дедлайн должен его закончить, а
    // сбой должен быть ApiError, а не голым AbortError.
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

  it('turns a network failure into an ApiError', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    const error = await apiGet('/items').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toContain('unreachable');
  });
});

describe('every request carries an id of its own', () => {
  it('sends an id of its own with every request', async () => {
    await apiGet('/items');

    const id = harness.lastRequestId();
    expect(id, 'the request carried no X-Request-Id header').toBeTruthy();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('sends a different id for every request', async () => {
    // Один id на весь процесс — это не id вовсе: второй сбой указал бы на
    // первый запрос в журнале краулера.
    await apiGet('/items');
    const first = harness.lastRequestId();

    await apiGet('/items');
    const second = harness.lastRequestId();

    expect(second).not.toBe(first);
  });

  it('attaches the query string only when it carries something', async () => {
    // Пустая строка запроса — это не «?», а ничего: URL с пустым хвостом попадает
    // в журналы доступа и в отчёты об ошибках.
    await apiGet('/items', { query: new URLSearchParams() });
    expect(harness.calls[0]!.url).not.toContain('?');

    await apiGet('/items', { query: new URLSearchParams({ page: '0' }) });
    expect(harness.calls[harness.calls.length - 1]!.url).toContain('?page=0');
  });
});
