/**
 * Общая оснастка для тестов клиента каталога.
 *
 * ## Зачем она отдельным файлом
 *
 * Четыре набора тестов клиента — транспорт, повтор, параметры, разбор ответа —
 * проверяют разные решения, но начинаются одинаково: подменить `fetch` рукописной
 * функцией, подменить ожидание рукописной функцией и задать переменные
 * окружения. Копировать эту оснастку в четыре файла — значит получить четыре
 * места, где одна и та же подмена должна оставаться одинаковой; разъехаться
 * они могут тихо, и тест, который проверяет одно решение, начнёт падать из-за
 * чужой подмены.
 *
 * ## Никаких моков
 *
 * `fetch` и ожидание подменяются рукописными функциями, которые ведут себя
 * предсказуемо: первая пишет, что было отправлено, вторая — сколько
 * миллисекунд клиент попросил подождать. Ни одна из них не «мокает» поведение
 * библиотеки: она его записывает.
 */

import { afterEach, beforeEach, expect, vi } from 'vitest';
import { sleeper } from '@/lib/api/retry';

/** Адрес, на который клиент ходит в тестах. */
export const API_URL = 'http://crawler.test:8080';

/** Ключ, который клиент отправляет в тестах. */
export const API_KEY = 'test-key-do-not-log';

/** Настоящий таймер, сохраняется до того, как его подменит тест. */
const realWait = sleeper.wait;

/** Один отправленный запрос: куда и с чем. */
export interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Что тест может узнать о сделанных запросах. */
export interface ClientHarness {
  /** Все запросы, в порядке отправки. */
  readonly calls: Call[];
  /** Все ожидания, которые клиент попросил, в миллисекундах. */
  readonly waits: number[];
  /** Строка запроса последнего запроса, ровно как она ушла. */
  lastQuery(): string;
  /** Идентификатор, который сайт отправил с последним запросом. */
  lastRequestId(): string;
  /**
   * Ответить на любой запрос заранее заданным ответом.
   *
   * Запись запроса продолжается: идентификатор, который сайт отправил, виден
   * только на запросе, который его нёс, а заглушка, которая глотает запрос,
   * скрывает его.
   */
  answerWith(response: Response): void;
}

/**
 * Ответ «сейчас не отдаём».
 *
 * Рукописный ответ, а не мок: тело и код, которые клиент должен увидеть.
 */
export function notReady(): Response {
  return new Response(JSON.stringify({ error: 'not ready' }), { status: 503 });
}

/** Ответ «всё в порядке». */
export function ready(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Ответ, который зависит от номера попытки.
 *
 * Рукописная функция: первая попытка получает один ответ, вторая — другой.
 * Именно так выглядит «краулер не отдаёт каталог, а потом отдаёт». Возвращает
 * функцию, которая скажет, сколько попыток было.
 */
export function stubAttempts(first: () => Response, second: () => Response): () => number {
  let attempt = 0;
  vi.stubGlobal('fetch', async () => {
    attempt += 1;
    return attempt === 1 ? first() : second();
  });
  return () => attempt;
}

/**
 * Поднять оснастку и вернуть её тесту.
 *
 * Хуки регистрируются здесь, поэтому вызывать это нужно на верхнем уровне
 * модуля теста — как и любую другую настройку `beforeEach`.
 */
export function useClientHarness(): ClientHarness {
  const calls: Call[] = [];
  const waits: number[] = [];
  let restoreEnv: Array<[string, string | undefined]> = [];

  beforeEach(() => {
    calls.length = 0;
    waits.length = 0;
    restoreEnv = [];

    // Ожидание — шов, и набор подменяет его: тест, который действительно спал бы
    // две секунды, был бы медленным, а тест, который измерял бы настоящую
    // задержку, падал бы на загруженной машине, а не на изменении в клиенте.
    sleeper.wait = async (ms: number) => {
      waits.push(ms);
    };

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
    sleeper.wait = realWait;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const [name, value] of restoreEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  return {
    calls,
    waits,
    lastQuery(): string {
      const call = calls[calls.length - 1];
      expect(call, 'the client did not make a request').toBeDefined();
      return new URL(call!.url).search.replace(/^\?/, '');
    },
    lastRequestId(): string {
      const call = calls[calls.length - 1];
      expect(call, 'the client did not make a request').toBeDefined();
      const headers = call!.init!.headers as Record<string, string>;
      return headers['X-Request-Id']!;
    },
    answerWith(response: Response): void {
      vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        // Свежая копия на каждый вызов: тело можно прочитать только один раз, а
        // клиент может спросить снова после `503` или таймаута.
        return response.clone();
      });
    },
  };
}
