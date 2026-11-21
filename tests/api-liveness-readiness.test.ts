/**
 * Живость процесса и готовность зависимости — два разных ответа.
 *
 * ## Что здесь под тестом
 *
 * Одно правило: **отказ краулера не делает витрину неживой.** Краулер живёт в
 * чужом репозитории и падает по своим причинам; контейнер витрины, который из-за
 * этого уходит в рестарт, чинит не то: краулер от этого не поднимается, а шум на
 * сервере прибавляется.
 *
 * Поэтому `/api/health` отвечает, что процесс может принять HTTP, и не
 * спрашивает краулера вовсе; `/api/ready` спрашивает и отвечает 503 с причиной.
 * Тест доказывает обе половины: живость при недоступном краулере и готовность,
 * которая этот отказ называет.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as liveness } from '@/app/api/health/route';
import { GET as readiness } from '@/app/api/ready/route';
import { useClientHarness } from './api-client-harness';

const harness = useClientHarness();

// A failed test must not leave fake timers behind for the next one.
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Ответ, который даёт упавший краулер: соединения нет вовсе.
 *
 * Запрос записывается здесь, а не в оснастке: `vi.stubGlobal` заменяет `fetch`
 * целиком, и подменная функция, которая только отвергает, оставила бы
 * `harness.calls` пустым — «живость не спросила краулера» стало бы верным для
 * любого кода, который её спросил.
 */
const attempts: string[] = [];
function unreachable(): void {
  attempts.length = 0;
  vi.stubGlobal('fetch', (input: unknown) => {
    attempts.push(String(input));
    return Promise.reject(new TypeError('fetch failed'));
  });
}

describe('liveness does not depend on the crawler', () => {
  it('answers 200 and asks the crawler nothing', async () => {
    unreachable();
    const response = await liveness();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(attempts).toEqual([]);
    expect(harness.calls).toEqual([]);
  });
});

describe('readiness reports the parser on its own endpoint', () => {
  it('answers 200 when the crawler is ready', async () => {
    const response = await readiness();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, parser: 'ready' });
  });

  // Готовность кэшируется на пять секунд, поэтому второй случай сдвигает
  // часы — иначе он получил бы закэшированный «да».
  it('answers 503 with the reason when the crawler is unreachable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    unreachable();
    const response = await readiness();
    const body = (await response.json()) as { ok: boolean; parser: string; detail: string | null };

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.parser).toBe('not-ready');
    // Наружу — класс отказа, а не текст ошибки: эндпоинт открыт публично, и
    // текст несёт адрес краулера и идентификатор запроса.
    expect(body.detail).toBe('unreachable');
  });

  it('names a rejected key and a deadline distinctly, and leaks no detail', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 120_000);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('{"error":"key rejected"}', { status: 401 })),
    );
    const rejected = (await (await readiness()).json()) as { detail: string };
    expect(rejected.detail).toBe('unauthorized');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 180_000);
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const unreachableBody = (await (await readiness()).json()) as { detail: string };
    expect(unreachableBody.detail).not.toContain('crawler.test');
  });
});
