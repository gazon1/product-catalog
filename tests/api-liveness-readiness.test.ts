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

/** Ответ, который даёт упавший краулер: соединения нет вовсе. */
function unreachable(): void {
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
}

describe('liveness does not depend on the crawler', () => {
  it('answers 200 and asks the crawler nothing', async () => {
    unreachable();
    const response = await liveness();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
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
    expect(body.detail).toContain('unreachable');
  });
});
