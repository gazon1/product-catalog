/**
 * Разбор ответа: как клиент читает то, что пришло.
 *
 * ## Что здесь под тестом
 *
 * Одно решение: **как прочитать ответ** — что делается с телом, во что
 * превращается неудачный ответ и какая ручка остаётся у оператора, когда всё
 * пошло не так.
 *
 * ## Идентификатор запроса
 *
 * Краулер записывает каждый запрос под идентификатором и отвечает тем же
 * идентификатором в заголовке `X-Request-Id`. Ошибка, которая не называет этот
 * идентификатор, — ошибка, которую оператор не найдёт, поэтому здесь проверяются
 * обе половины корреляции: идентификатор, который отправил сайт, и
 * идентификатор, которым ответил краулер, — включая случай, когда краулер не
 * ответил вовсе.
 */

import { describe, expect, it, vi } from 'vitest';
import { apiGet, apiGetText, ApiError } from '@/lib/api/client';
import { API_KEY, useClientHarness } from './api-client-harness';

const harness = useClientHarness();

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

  it('quotes the API’s own error field in the message', async () => {
    // «Ключ не подходит» — фраза, с которой оператор может что-то сделать, а
    // голый `401` — нет.
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: 'the key does not match' }), { status: 401 }),
    );

    const error = (await apiGet('/items').catch((err: unknown) => err)) as ApiError;
    expect(error.message).toContain('the key does not match');
  });

  it('keeps the parsed body on the error', async () => {
    // Код ответа и тело вместе — обычно и есть весь диагноз: `400` говорит, какой
    // параметр неверен, `401` — что неверен ключ.
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: 'bad parameter' }), { status: 400 }),
    );

    const error = (await apiGet('/items').catch((err: unknown) => err)) as ApiError;
    expect(error.body).toEqual({ error: 'bad parameter' });
    expect(error.path).toBe('/items');
  });
});

describe('a successful answer becomes a structure', () => {
  it('returns the parsed body', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ items: [{ id: 1 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(apiGet('/items')).resolves.toEqual({ items: [{ id: 1 }] });
  });

  it('keeps a body that is not JSON as text', async () => {
    // HTML-страница ошибки от прокси говорит больше, чем голый код ответа, — но
    // только если её не выбросили по дороге.
    vi.stubGlobal('fetch', async () =>
      new Response('<html>proxy error</html>', { status: 200 }),
    );

    await expect(apiGet('/items')).resolves.toBe('<html>proxy error</html>');
  });

  it('returns the raw text for the endpoint that is not JSON', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response('openapi: 3.0.0', { status: 200 }),
    );

    await expect(apiGetText('/contract')).resolves.toBe('openapi: 3.0.0');
  });

  it('turns a failed answer to the text endpoint into an ApiError', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
    );

    await expect(apiGetText('/contract')).rejects.toMatchObject({ status: 404 });
  });
});

describe('the error names the request an operator can look up', () => {
  it('names the crawler’s id when the call failed', async () => {
    harness.answerWith(
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
    // Краулер, который не шлёт заголовок, — не повод терять корреляцию:
    // собственный идентификатор сайта всё ещё тот, что ушёл.
    harness.answerWith(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));

    const error = (await apiGet('/items').catch((err: unknown) => err)) as ApiError;
    const sent = harness.lastRequestId();

    expect(error.message).toContain(`(request ${sent})`);
    expect(error.message).not.toContain('undefined');
    expect(error.requestId).toBe(sent);
  });

  it('names its own id when the crawler never answered', async () => {
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      harness.calls.push({ url: String(input), init });
      throw new TypeError('fetch failed');
    });

    const error = (await apiGet('/items').catch((err: unknown) => err)) as ApiError;
    const sent = harness.lastRequestId();

    expect(error.message).toContain(`(request ${sent})`);
    expect(error.message).not.toContain('undefined');
    expect(error.requestId).toBe(sent);
  });

  it('names its own id when the request timed out', async () => {
    vi.stubGlobal(
      'fetch',
      (input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          harness.calls.push({ url: String(input), init });
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );

    const error = (await apiGet('/items', { connectTimeoutMs: 20, timeoutMs: 20 }).catch(
      (err: unknown) => err,
    )) as ApiError;
    const sent = harness.lastRequestId();

    expect(error.message).toContain(`(request ${sent})`);
    expect(error.requestId).toBe(sent);
  });

  it('never puts the key in the message that carries the id', async () => {
    harness.answerWith(
      new Response(JSON.stringify({ error: 'nope' }), {
        status: 401,
        headers: { 'X-Request-Id': 'crawler-log-id' },
      }),
    );

    const error = (await apiGet('/items').catch((err: unknown) => err)) as ApiError;
    expect(error.message).not.toContain(API_KEY);
  });
});
