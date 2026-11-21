/**
 * Гейт «витрина не управляет краулером».
 *
 * ## Что здесь под тестом
 *
 * Одно правило: **в этом репозитории нет ни одной строки, которая запускает,
 * останавливает или проверяет краулера.** Краулер и его база обслуживаются в
 * репозитории краулера (`gazon1/wb-parser-kotlin-new`); витрина — клиент его
 * HTTP API и больше ничего.
 *
 * Проверяется форма, а не смысл: compose-файлы не объявляют сервис краулера и
 * не объявляют сервис базы, у ни одного сервиса нет `depends_on`, justfile не
 * содержит команд жизненного цикла краулера, скрипты стенки не знают имён
 * контейнеров краулера, а workflow деплоя не читает `.deployed-digest`.
 *
 * Почему это стоит гейтом, а не комментарием: всё это — ровно те места, где
 * «мы на минуту подняли краулера рядом с витриной» превращается в постоянное
 * состояние, в котором витрина снова управляет чужим сервисом.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(__dirname, '..', '..');

const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

/** Имена сервисов во всех compose-файлах репозитория. */
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.dev.yml'];

/**
 * Имена, которые не могут быть именами сервиса этого репозитория: краулер и
 * база краулера — не наши сервисы.
 */
const FOREIGN = /parser|crawler|wbparser|postgres|\bdb\b/i;

describe('the compose files manage no crawler and no database', () => {
  it.each(COMPOSE_FILES)('%s declares only the storefront', (file) => {
    const compose = parse(read(file)) as {
      services?: Record<string, { depends_on?: unknown }>;
    };
    const services = Object.keys(compose.services ?? {});

    expect(services.length).toBeGreaterThan(0);
    for (const name of services) {
      expect(name, `${file}: the service '${name}' is not the storefront's`).not.toMatch(
        FOREIGN,
      );
    }
  });

  it.each(COMPOSE_FILES)('%s has no depends_on', (file) => {
    const compose = parse(read(file)) as {
      services?: Record<string, { depends_on?: unknown }>;
    };
    for (const [name, service] of Object.entries(compose.services ?? {})) {
      expect(service.depends_on, `${file}: the service '${name}' depends on something`).toBeUndefined();
    }
  });

  it.each(COMPOSE_FILES)('%s has no volume of its own', (file) => {
    const compose = parse(read(file)) as { volumes?: Record<string, unknown> };
    expect(Object.keys(compose.volumes ?? {})).toEqual([]);
  });
});

describe('nothing in the repository manages the crawler’s lifecycle', () => {
  it('the justfile has no crawler lifecycle commands', () => {
    const justfile = read('justfile');
    expect(justfile).not.toMatch(/^db-(up|down|reset)\b/m);
    expect(justfile).not.toMatch(/^ansible-deploy\b/m);
    expect(justfile).not.toMatch(/wbparser|wb-parser/i);
  });

  it('the stack scripts do not name the crawler’s containers', () => {
    for (const file of ['scripts/stack-up.sh', 'scripts/stack-down.sh']) {
      const script = read(file);
      expect(script, `${file}: the crawler is not ours to stop`).not.toMatch(
        /product-catalog-dev-(parser|db)/,
      );
    }
  });

  it('the deploy workflow neither deploys the crawler nor checks which one runs', () => {
    const workflow = read('.github/workflows/deploy.yml');
    expect(workflow).not.toMatch(/\.deployed-digest/);
    expect(workflow).not.toMatch(/wbparser|wb-parser/i);
  });
});
