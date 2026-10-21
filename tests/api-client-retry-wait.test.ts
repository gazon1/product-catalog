/**
 * Ожидание перед повтором: сколько клиент ждёт, прежде чем спросить снова.
 *
 * ## Что здесь под тестом
 *
 * Одно решение: **сколько ждать перед вторым вопросом**. Сам повтор — когда его
 * уместно — проверяется в `api-client-retry.test.ts`; здесь проверяется только
 * ожидание.
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
import {
  apiGet,
  ApiError,
  RETRY_AFTER_DEFAULT_MS,
  RETRY_AFTER_MAX_MS,
  sleeper,
  TIMEOUT_RETRY_BACKOFF_MS,
} from '@/lib/api/client';
import { notReady, ready, stubAttempts, useClientHarness } from './api-client-harness';

const harness = useClientHarness();

/** Настоящий таймер, до того как его подменила оснастка. */
const realWait = sleeper.wait;

/**
 * Повтор ждёт перед следующим вопросом.
 *
 * Повтор, который уходит в ту же миллисекунду, — это повтор, который приходит
 * в момент, когда краулер всё ещё говорит «нет». Ожидание — это названный
 * ответом момент, с дрожанием, чтобы отказанные в один момент вызывающие не
 * повторили строго в общем ритме, и с ограничением сверху, чтобы заголовок не
 * держал отрисовку страницы минуту.
 *
 * Ожидания записываются, а не исполняются: набор подменяет шов, поэтому эти
 * случаи доказывают, чего клиент попросил, не тратя на это времени.
 */
describe('the retry waits before it asks again', () => {
  it('waits for the moment the answer named', async () => {
    stubAttempts(
      () =>
        new Response(JSON.stringify({ error: 'not ready' }), {
          status: 503,
          headers: { 'Retry-After': '2' },
        }),
      ready,
    );
    // Половина вычисленного ожидания: задержка — доля ожидания, а не оно само.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const body = await apiGet<{ ok: boolean }>('/items');

    expect(body.ok).toBe(true);
    expect(harness.waits).toHaveLength(1);
    expect(harness.waits[0]).toBe(1_000);
    expect(harness.waits[0]).toBeLessThanOrEqual(2_000);
  });

  it('never waits exactly the amount it was told', async () => {
    // Отказанные в один момент вызывающие иначе повторили бы строго в общем
    // ритме и ударили по краулеру ещё одной волной.
    stubAttempts(
      () =>
        new Response(JSON.stringify({ error: 'not ready' }), {
          status: 503,
          headers: { 'Retry-After': '2' },
        }),
      ready,
    );
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    await apiGet('/items');

    expect(harness.waits[0]).not.toBe(2_000);
    expect(harness.waits[0]).toBeGreaterThan(0);
  });

  it('asks again only after the wait', async () => {
    // Порядок и есть смысл: второй запрос не должен уйти, пока краулер всё ещё
    // отказывает.
    const events: string[] = [];
    let attempt = 0;
    vi.stubGlobal('fetch', async () => {
      attempt += 1;
      events.push(`request ${attempt}`);
      return attempt === 1
        ? new Response(JSON.stringify({ error: 'not ready' }), {
            status: 503,
            headers: { 'Retry-After': '2' },
          })
        : ready();
    });
    sleeper.wait = async () => {
      events.push('wait');
    };

    await apiGet('/items');

    expect(events).toEqual(['request 1', 'wait', 'request 2']);
  });

  it('caps the wait the answer asked for', async () => {
    // Вызывающий не должен висеть минуту из-за того, что сервер так сказал.
    stubAttempts(
      () =>
        new Response(JSON.stringify({ error: 'not ready' }), {
          status: 503,
          headers: { 'Retry-After': '600' },
        }),
      ready,
    );
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    await apiGet('/items');

    expect(harness.waits).toHaveLength(1);
    expect(harness.waits[0]).toBeLessThanOrEqual(RETRY_AFTER_MAX_MS);
    expect(harness.waits[0]).toBeGreaterThan(0);
  });

  it('waits a little when the answer names no moment', async () => {
    // 503 без `Retry-After` всё равно значит «не сейчас»: спросить снова в ту же
    // миллисекунду — значит спросить снова, пока краулер всё ещё говорит «нет».
    stubAttempts(notReady, ready);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    await apiGet('/items');

    expect(harness.waits).toHaveLength(1);
    expect(harness.waits[0]).toBeGreaterThan(0);
    expect(harness.waits[0]).toBeLessThanOrEqual(RETRY_AFTER_DEFAULT_MS);
  });

  it('waits a short backoff after a timeout', async () => {
    // Таймаут значит, что краулер медленный, а не что его нет: запрос, который
    // он выполнял, может всё ещё выполняться. Второй запрос в ту же
    // миллисекунду добавляет давления ровно тогда, когда сервис уже медленный.
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
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const body = await apiGet<{ ok: boolean }>('/items', { connectTimeoutMs: 20, timeoutMs: 20 });

    expect(body.ok).toBe(true);
    expect(harness.waits).toHaveLength(1);
    expect(harness.waits[0]).toBeGreaterThan(0);
    expect(harness.waits[0]).toBeLessThanOrEqual(TIMEOUT_RETRY_BACKOFF_MS);
  });

  it('never waits before an answer it does not retry', async () => {
    // 429 — это ответ, и вызывающий вправе его увидеть — сколько бы его
    // `Retry-After` ни просил подождать.
    for (const status of [400, 404, 429]) {
      harness.waits.length = 0;
      vi.stubGlobal('fetch', async () =>
        status === 429
          ? new Response(JSON.stringify({ error: 'too many requests' }), {
              status,
              headers: { 'Retry-After': '5' },
            })
          : new Response(JSON.stringify({ error: 'no' }), { status }),
      );

      await expect(apiGet('/items')).rejects.toMatchObject({ status });
      expect(harness.waits).toEqual([]);
    }
  });

  it('never waits before a network failure', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    await expect(apiGet('/items')).rejects.toBeInstanceOf(ApiError);
    expect(harness.waits).toEqual([]);
  });

  it('waits with a real timer when nothing replaces the seam', async () => {
    // Шов — это шов, а не дыра: то, что использует работающий сайт, — таймер,
    // который ждёт.
    await expect(realWait(0)).resolves.toBeUndefined();
  });
});
