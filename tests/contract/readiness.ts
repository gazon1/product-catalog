/**
 * Готовность краулера: как его спрашивают и сколько ждут ответа.
 *
 * ## Зачем это отдельный файл
 *
 * Готовность — одно решение с двумя сторонами: что именно спрашивать у
 * краулера и сколько ждут ответа. Стороны разные, а решение одно: пока
 * готовность не наступила, прогон не начинается.
 *
 * ## Бюджет готовности наш, а не testcontainers'
 *
 * Стратегия ожидания testcontainers по умолчанию ждёт, пока порт контейнера
 * будет занят, и сдаётся через 60 секунд, выбрасывая собственное «Port 8080
 * not bound after 60000ms». Это сообщение неверно дважды: краулеру ниже дают
 * две минуты, поэтому чужой срок срабатывает первым, и причина, по которой
 * краулер медленный — или причина, по которой он умер, — в собственном логе
 * краулера, которого чужое сообщение не показывает.
 *
 * Поэтому контейнер запускается без ожидания порта, а готовность опрашивается
 * здесь, на нашем бюджете. Контейнеру, которому нужна минута с полуторой на
 * миграции и сид, медленно, а не сломан, — и бюджет говорит именно это.
 *
 * ## Проверка — это заявление самого краулера
 *
 * Проверка — это собственное заявление краулера о том, что каталог можно
 * отдавать: его пул выполняет запрос, и колонки, которые читает каталог, на
 * месте. Ожидание её значит, что контрактный тест начинается против краулера,
 * который уже накатил миграции и засеял себя.
 *
 * ## Что означает каждый ответ
 *
 *   - `200` — краулер готов;
 *   - `401` — ключ не тот: это отдельная беда, и она о ней говорит;
 *   - `404` — в образе нет каталогового API;
 *   - что угодно ещё — «пока не готов», и это не повод прекращать ждать.
 *
 * А что именно сказать о неудаче — в `tests/contract/diagnosis.ts`.
 */

import type { StartedTestContainer } from 'testcontainers';
import {
  describeExit,
  describeMissingCatalogApi,
  describeRejectedKey,
  describeTimeout,
  inspectContainer,
} from './diagnosis';
import { API_KEY, CRAWLER_PORT, READY_TIMEOUT_MS } from './environment';

/** Что вышло из проверки готовности краулера. */
type CrawlerStartup = { apiUrl: string; error: null } | { apiUrl: string | null; error: string };

/** Что сказала одна проверка готовности. */
type Probe =
  | { kind: 'ready' }
  | { kind: 'unauthorized' }
  | { kind: 'no-catalog-api' }
  | { kind: 'not-ready'; detail: string };

/**
 * Дождаться, пока краулер ответит на свою проверку готовности.
 *
 * Ожидание здесь, а не у testcontainers: контейнер запускается без ожидания
 * порта, и готовность опрашивается здесь, пока не потрачен
 * READY_TIMEOUT_MS. Контейнеру, которому нужна минута с полуторой на миграции
 * и сид, медленно, а не сломан, — и бюджет говорит именно это.
 */
export async function waitForCrawler(container: StartedTestContainer): Promise<CrawlerStartup> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let apiUrl: string | null = null;
  let lastProblem = 'the crawler did not answer';

  while (Date.now() < deadline) {
    // Сначала собственное состояние контейнера: упавший контейнер не
    // ответит никогда, а его код возврата и лог говорят почему.
    const state = await inspectContainer(container);
    if (state !== null && !state.running) {
      return { apiUrl: null, error: await describeExit(container, state) };
    }

    if (apiUrl === null) {
      apiUrl = apiUrlOf(container);
      if (apiUrl === null) {
        lastProblem = 'the container has not published its port yet';
      }
    }

    if (apiUrl !== null) {
      const probe = await probeReady(apiUrl);

      if (probe.kind === 'ready') return { apiUrl, error: null };

      if (probe.kind === 'unauthorized') {
        return { apiUrl, error: describeRejectedKey() };
      }

      if (probe.kind === 'no-catalog-api') {
        return { apiUrl, error: describeMissingCatalogApi() };
      }

      lastProblem = probe.detail;
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }

  // Бюджет потрачен. Сказать, что это таймаут: контейнер, который всё ещё
  // работает и просто медленный, — это не неверный образ, и сообщение,
  // которое говорит обратное, отправляет читателя не туда.
  return { apiUrl, error: await describeTimeout(container, lastProblem) };
}

/** Спросить у краулера его endpoint готовности один раз. */
async function probeReady(apiUrl: string): Promise<Probe> {
  try {
    const response = await fetch(`${apiUrl}/ready`, {
      headers: { 'X-Api-Key': API_KEY },
      signal: AbortSignal.timeout(3_000),
    });

    if (response.ok) return { kind: 'ready' };
    if (response.status === 401) return { kind: 'unauthorized' };
    if (response.status === 404) return { kind: 'no-catalog-api' };
    return { kind: 'not-ready', detail: `the readiness probe answered ${response.status}` };
  } catch (err) {
    return { kind: 'not-ready', detail: err instanceof Error ? err.message : 'unknown error' };
  }
}

/**
 * Базовый адрес каталогового API, если контейнер опубликовал свой порт.
 *
 * Привязка порта появляется, когда контейнер создаётся, но у контейнера,
 * который умер раньше, чем рантайм сообщил о нём, привязки нет вовсе — и это
 * здесь не ошибка: цикл вызывающего спрашивает, пока не кончится бюджет, а
 * проверка состояния выше различает эти два случая.
 */
function apiUrlOf(container: StartedTestContainer): string | null {
  try {
    return `http://${container.getHost()}:${container.getMappedPort(CRAWLER_PORT)}/api/catalog/v1`;
  } catch {
    return null;
  }
}
