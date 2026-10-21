/**
 * Повтор клиента: когда витрина спрашивает каталог ещё раз.
 *
 * ## Что здесь под тестом
 *
 * Одно решение: **когда спросить ещё раз** — какие сбои стоят второй попытки.
 *
 * Сколько именно ждать перед второй попыткой — отдельное решение, и оно
 * проверяется в `api-client-retry-wait.test.ts`.
 *
 * ## Почему здесь нет настоящих пауз
 *
 * Ожидание — шов: набор подменяет его рукописной функцией, которая записывает,
 * сколько миллисекунд клиент попросил подождать, и возвращается сразу. Тест,
 * который действительно спит, был бы медленным, а тест, который измеряет
 * настоящую задержку, падал бы на загруженной машине, а не на изменении в
 * клиенте. Ни один тест в этом файле не ждёт ни миллисекунды.
 */

import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet } from '@/lib/api/client';
import { notReady, ready, stubAttempts, useClientHarness } from './api-client-harness';

const harness = useClientHarness();

describe('one retry, and only where a retry helps', () => {
  it('asks again once after a 503', async () => {
    // 503 — это краулер говорит «каталог сейчас не отдаётся». Запрос был
    // правильным; момент был неудачным — и спросить снова это разница между
    // страницей, которая отрисовалась, и страницей с ошибкой.
    const attempts = stubAttempts(notReady, ready);

    const body = await apiGet<{ ok: boolean }>('/items');
    expect(body.ok).toBe(true);
    expect(attempts()).toBe(2);
  });

  it('asks again at most once after a 503', async () => {
    // Повтор — это запрос, о котором вызывающий не просил, и он стоит базе
    // краулера ещё одного запроса. Один повтор превращает неудачный момент в
    // работающую страницу; два превращают лежащий краулер в троекную нагрузку.
    const attempts = stubAttempts(notReady, notReady);

    await expect(apiGet('/items')).rejects.toMatchObject({ status: 503 });
    expect(attempts()).toBe(2);
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
        return Promise.resolve(ready());
      },
    );

    const body = await apiGet<{ ok: boolean }>('/items', { connectTimeoutMs: 20, timeoutMs: 20 });
    expect(body.ok).toBe(true);
    expect(attempt).toBe(2);
  });

  it('never asks again after a 4xx', async () => {
    // 4xx — это краулер говорит «этот запрос неверен». Вторая попытка была бы
    // неверна ровно так же, и она удвоила бы трафик того, кто зовёт со сломанным
    // ключом.
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

  it('never asks again after a 5xx that is not a 503', async () => {
    // «Каталог не отдаётся» — это 503, и только он: 500 говорит о сбое внутри
    // краулера, и повтор на том же запросе скорее повторит тот же сбой.
    let attempt = 0;
    vi.stubGlobal('fetch', async () => {
      attempt += 1;
      return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    });

    await expect(apiGet('/items')).rejects.toMatchObject({ status: 500 });
    expect(attempt).toBe(1);
  });

  it('never asks again after a network failure', async () => {
    // Краулера там нет, и вторая попытка застала бы его там же — вызывающему
    // честная ошибка полезнее запроса, который вдвое дольше падает так же.
    let attempt = 0;
    vi.stubGlobal('fetch', async () => {
      attempt += 1;
      throw new TypeError('fetch failed');
    });

    await expect(apiGet('/items')).rejects.toBeInstanceOf(ApiError);
    expect(attempt).toBe(1);
  });

  it('sends a different request id with the second attempt', async () => {
    // Две попытки — это два запроса, и в журнале краулера две записи. Одинаковый
    // id сделал бы их неразличимыми.
    let attempt = 0;
    const ids: Array<string | null | undefined> = [];
    vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
      attempt += 1;
      const headers = new Headers(init?.headers);
      ids.push(headers.get('X-Request-Id'));
      return attempt === 1 ? notReady() : ready();
    });

    await apiGet('/items');
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });
});
