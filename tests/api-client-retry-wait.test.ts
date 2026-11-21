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
import { retryAfterMs } from '@/lib/api/retry';
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
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const body = await apiGet<{ ok: boolean }>('/items');

    expect(body.ok).toBe(true);
    expect(harness.waits).toHaveLength(1);
    // Названный момент — минимум: дрожание добавляет к нему, а не урезает его.
    expect(harness.waits[0]).toBeGreaterThanOrEqual(2_000);
    expect(harness.waits[0]).toBeLessThanOrEqual(2_000 + RETRY_AFTER_DEFAULT_MS);
  });

  it('never waits less than the answer asked for', async () => {
    // Дрожание отказывает в общем ритме, но не разрешает спросить раньше, чем
    // сервер назвал момент: это его слово о том, сколько длится отказ.
    for (const random of [0, 0.999]) {
      harness.waits.length = 0;
      stubAttempts(
        () =>
          new Response(JSON.stringify({ error: 'not ready' }), {
            status: 503,
            headers: { 'Retry-After': '2' },
          }),
        ready,
      );
      vi.spyOn(Math, 'random').mockReturnValue(random);

      await apiGet('/items');

      expect(harness.waits[0]).toBeGreaterThanOrEqual(2_000);
    }
  });

  it('waits for an HTTP-date the answer named', async () => {
    // Вторая законная форма заголовка — абсолютный момент, а не секунды.
    stubAttempts(
      () =>
        new Response(JSON.stringify({ error: 'not ready' }), {
          status: 503,
          headers: { 'Retry-After': new Date(Date.now() + 5_000).toUTCString() },
        }),
      ready,
    );
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const body = await apiGet<{ ok: boolean }>('/items');

    expect(body.ok).toBe(true);
    expect(harness.waits).toHaveLength(1);
    // Метка времени округлена до секунды, поэтому минимум — чуть меньше пяти.
    expect(harness.waits[0]).toBeGreaterThanOrEqual(4_000);
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

  it('does not shorten a wait that exceeds the retry budget', async () => {
    // Укоротить чужой момент до бюджета — это повтор раньше разрешённого, то же
    // нарушение, только тише. Такой ответ отдаётся как есть, без второй попытки.
    for (const header of [String(RETRY_AFTER_MAX_MS / 1000 + 1), '600']) {
      harness.waits.length = 0;
      const attempts = stubAttempts(
        () =>
          new Response(JSON.stringify({ error: 'not ready' }), {
            status: 503,
            headers: { 'Retry-After': header },
          }),
        ready,
      );

      await expect(apiGet('/items')).rejects.toMatchObject({ status: 503 });
      expect(attempts()).toBe(1);
      expect(harness.waits).toEqual([]);
    }
  });

  it('waits exactly the budget when the answer asks for the whole of it', async () => {
    // Граница: бюджет — это ещё не «сверх бюджета», и такой момент исполним.
    stubAttempts(
      () =>
        new Response(JSON.stringify({ error: 'not ready' }), {
          status: 503,
          headers: { 'Retry-After': String(RETRY_AFTER_MAX_MS / 1000) },
        }),
      ready,
    );
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const body = await apiGet<{ ok: boolean }>('/items');

    expect(body.ok).toBe(true);
    expect(harness.waits[0]).toBe(RETRY_AFTER_MAX_MS);
  });

  it('never waits past the budget, however far the answer reaches', async () => {
    // Момент чуть ниже бюджета — самое узкое место добавки: она не должна
    // вынести ожидание за бюджет, но и не должна срезать названное ожидание.
    stubAttempts(
      () =>
        new Response(JSON.stringify({ error: 'not ready' }), {
          status: 503,
          headers: { 'Retry-After': String(RETRY_AFTER_MAX_MS / 1000 - 1) },
        }),
      ready,
    );
    vi.spyOn(Math, 'random').mockReturnValue(0.999);

    await apiGet('/items');

    expect(harness.waits[0]).toBeGreaterThanOrEqual(RETRY_AFTER_MAX_MS - 1_000);
    expect(harness.waits[0]).toBeLessThanOrEqual(RETRY_AFTER_MAX_MS);
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

/**
 * Разбор заголовка: какие значения называют момент и сколько до него.
 *
 * Обе законные формы и всё, что момента не называет. Момент в прошлом —
 * разрешение спросить сейчас, а не запрет: `0`, а не отказ от повтора.
 */
describe('the answer’s moment is read in both forms HTTP allows', () => {
  const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');

  it('reads delay-seconds', () => {
    expect(retryAfterMs('2', now)).toBe(2_000);
    expect(retryAfterMs('0', now)).toBe(0);
    expect(retryAfterMs(' 120 ', now)).toBe(120_000);
  });

  it('reads an HTTP-date as the time left until it', () => {
    expect(retryAfterMs('Wed, 21 Oct 2015 07:28:05 GMT', now)).toBe(5_000);
    expect(retryAfterMs(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
  });

  it('reads all three forms HTTP defines', () => {
    // IMF-fixdate, rfc850 и asctime — три формы, которые называет HTTP.
    for (const header of [
      'Sun, 06 Nov 1994 08:49:37 GMT',
      'Sunday, 06-Nov-94 08:49:37 GMT',
      'Sun Nov  6 08:49:37 1994',
    ]) {
      expect(retryAfterMs(header, Date.parse(header) - 1_000)).toBe(1_000);
    }
  });

  it('reads the rfc850 two-digit year the way HTTP does, not the way Date.parse does', () => {
    // 69 в 2026 — это 2069: год, оказавшийся больше чем на 50 лет в будущем,
    // означает ближайший прошлый год с теми же цифрами. `Date.parse` сказал бы
    // 1969, и клиент повторил бы немедленно вместо ожидания.
    const in2026 = Date.parse('Wed, 21 Oct 2026 12:00:00 GMT');
    const expected = Date.parse('Nov 06, 2069 08:49:37 GMT') - in2026;

    expect(retryAfterMs('Sunday, 06-Nov-69 08:49:37 GMT', in2026)).toBe(expected);
    expect(retryAfterMs('Sunday, 06-Nov-50 08:49:37 GMT', in2026)).toBe(
      Date.parse('Nov 06, 2050 08:49:37 GMT') - in2026,
    );
    // А год, который в будущем не оказался, читается как есть.
    expect(retryAfterMs('Sunday, 06-Nov-94 08:49:37 GMT', in2026)).toBe(0);
  });

  it('rejects weekday names HTTP does not define', () => {
    // `Date.parse` принимает и `Foo, 06 Nov 1994 …` — форма заголовка этого не
    // делает, и мусор остаётся мусором.
    for (const header of [
      'Foo, 06 Nov 1994 08:49:37 GMT',
      'Xyz Nov  6 08:49:37 1994',
      'Фу, 06 Nov 1994 08:49:37 GMT',
      'Funday, 06-Nov-94 08:49:37 GMT',
    ]) {
      expect(retryAfterMs(header, now)).toBeNull();
    }
  });

  it('rejects dates that HTTP does not define', () => {
    // `Date.parse` принял бы их — но это не `Retry-After`, и принимать их
    // значило бы превратить мусорный заголовок в настоящее ожидание.
    for (const header of ['1 Jan 2027', '2027-01-01', 'Jan 1 2027', '2027/01/01']) {
      expect(retryAfterMs(header, now)).toBeNull();
    }
  });

  it('reads a moment in the past as zero, not as no moment', () => {
    // Сервер сказал «можно уже»: повтор немедленный, а не по умолчанию.
    expect(retryAfterMs('Wed, 21 Oct 2015 07:27:00 GMT', now)).toBe(0);
    expect(retryAfterMs('0', now)).toBe(0);
  });

  it('nameless values are nameless', () => {
    for (const header of [null, '', '   ', '-5', '1.5', 'soon', 'next tuesday', '2s']) {
      expect(retryAfterMs(header, now)).toBeNull();
    }
  });

  it('does not bound the moment at the retry budget', () => {
    // Бюджет — решение вызывающего, а не свойство значения: разбор обязан
    // вернуть то, что сказал сервер, чтобы укорачивание было видно и запрещено.
    expect(retryAfterMs(String(RETRY_AFTER_MAX_MS / 1000 + 1), now)).toBe(RETRY_AFTER_MAX_MS + 1_000);
    expect(retryAfterMs('86400', now)).toBe(86_400_000);
  });

  it('reads a delay too large for a double as “forever”, not as malformed', () => {
    // Заведомо дольше любого бюджета — это «не повторять». `null` здесь означал
    // бы «заголовка нет» и повтор через ожидание по умолчанию — раньше срока.
    expect(retryAfterMs('1' + '0'.repeat(400), now)).toBe(Infinity);
  });
});

describe('a delay that cannot be represented still cannot be shortened', () => {
  it('does not retry early when the answer asks for more than a double holds', async () => {
    const attempts = stubAttempts(
      () =>
        new Response(JSON.stringify({ error: 'not ready' }), {
          status: 503,
          headers: { 'Retry-After': '1' + '0'.repeat(400) },
        }),
      ready,
    );

    await expect(apiGet('/items')).rejects.toMatchObject({ status: 503 });
    expect(attempts()).toBe(1);
    expect(harness.waits).toEqual([]);
  });
});
