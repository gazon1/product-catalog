/**
 * Гейт «живость — это живость, а не готовность».
 *
 * ## Что здесь под тестом
 *
 * Одно правило: **healthcheck контейнера и smoke-test деплоя спрашивают о
 * процессе витрины, а не о краулере.** Иначе отказ краулера выглядит как
 * падение витрины: контейнер уходит в рестарт, деплой краснеет на «storefront
 * unhealthy», и разбирают не ту систему.
 *
 * Проверяется два разных слоя, и порознь:
 *
 *   - **проводка** — Dockerfile, compose и workflow спрашивают те эндпоинты,
 *     которые называют; это читается как текст;
 *   - **поведение** — сам `scripts/smoke-test.sh` исполняется против
 *     подставного сервера: живость важна, готовность — предупреждение. Логика,
 *     зашитая в YAML, проверялась бы регулярным выражением по собственному
 *     тексту, а такое остаётся зелёным, когда меняется ветка, которая выходит
 *     с `1`.
 *
 * Сами эндпоинты проверяет `tests/api-liveness-readiness.test.ts`.
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

  it('the deploy smoke test runs the script that implements the policy', () => {
    const workflow = parse(read('.github/workflows/deploy.yml')) as {
      jobs: { deploy: { steps: { name?: string; run?: string }[] } };
    };
    const step = workflow.jobs.deploy.steps.find((s) => s.name === 'Smoke test');
    expect(step, 'the deploy workflow has no Smoke test step').toBeDefined();
    // The step runs the script, and the script is executed by the test below —
    // so the assertions here cover wiring, and the behaviour is proven elsewhere.
    expect(step!.run).toContain('./scripts/smoke-test.sh');
  });

  // The container-side probe is the other half of the same policy: a refused
  // request is a misconfiguration this deploy wrote and must fail, while the
  // crawler not answering is somebody else's downtime and must not. The policy
  // lives in a script so that `tests/deploy-probe.test.ts` executes it; this
  // gate only keeps the workflow step pointed at that script.
  it('the container probe step runs the script that implements the policy', () => {
    const workflow = parse(read('.github/workflows/deploy.yml')) as {
      jobs: { deploy: { steps: { name?: string; run?: string }[] } };
    };
    const step = workflow.jobs.deploy.steps.find(
      (s) => s.name === 'The storefront reaches the catalog API from inside the container',
    );
    expect(step, 'the deploy workflow has no container-side catalog probe').toBeDefined();
    expect(step!.run).toContain('./scripts/probe-catalog-from-container.sh');
  });
});
