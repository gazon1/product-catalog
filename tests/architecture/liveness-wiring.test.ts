/**
 * Гейт «живость — это живость, а не готовность».
 *
 * ## Что здесь под тестом
 *
 * Одно правило: **healthcheck контейнера, `wait-healthy` и smoke-test деплоя
 * спрашивают о процессе витрины, а не о краулере.** Иначе отказ краулера
 * выглядит как падение витрины: контейнер уходит в рестарт, деплой краснеет на
 * «storefront unhealthy», и разбирают не ту систему.
 *
 * Проверяется форма, а не смысл: Docker healthcheck и compose-файл ходят на
 * `/api/health`, а готовность (`/api/ready`) спрашивают отдельные шаги, которые
 * говорят об отказе зависимости своими словами. Проба `/api/health` до краулера
 * не ходит вовсе — это проверяет `tests/api-liveness-readiness.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(__dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

describe('liveness and dependency readiness stay apart', () => {
  it('the image healthcheck asks liveness only', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*?\/api\/health/);
    expect(dockerfile.split('HEALTHCHECK')[1]).not.toMatch(/\/api\/ready/);
  });

  it('the compose healthcheck asks liveness only', () => {
    const compose = parse(read('docker-compose.yml')) as {
      services: Record<string, { healthcheck?: { test?: unknown } }>;
    };
    const test = JSON.stringify(compose.services['product-catalog']?.healthcheck?.test ?? '');
    expect(test).toContain('/api/health');
    expect(test).not.toContain('/api/ready');
  });

  it('the deploy smoke test asks liveness and reports readiness separately', () => {
    const workflow = read('.github/workflows/deploy.yml');
    // Живость — то, из-за чего деплой краснеет.
    expect(workflow).toMatch(/\$SMOKE_URL\/api\/health/);
    // Готовность — отдельный вопрос, и на него отвечают словами о зависимости.
    expect(workflow).toMatch(/\$SMOKE_URL\/api\/ready/);
    expect(workflow).toMatch(/catalog dependency is not ready[\s\S]*?not a storefront process failure/);
  });
});
