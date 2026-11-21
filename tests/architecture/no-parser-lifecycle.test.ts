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

/**
 * Compose-файлы репозитория и единственный сервис, который в каждом из них
 * есть: витрина и только она.
 */
const COMPOSE_FILES: Record<string, string> = {
  'docker-compose.yml': 'product-catalog',
  'docker-compose.dev.yml': 'web',
};

/**
 * Имена, которые не могут быть именем сервиса, образа или команды этого
 * репозитория: краулер и база краулера — не наши.
 */
const FOREIGN = /parser|crawler|wbparser|postgres|\bdb\b/i;

/**
 * Переменные, которых у витрины быть не должно: она не ходит в базу, и
 * у неё нет ни одного credential'а от базы краулера.
 */
const FOREIGN_ENV = /\b(DATABASE|POSTGRES|PG)\b/i;

type Service = {
  image?: unknown;
  build?: unknown;
  command?: unknown;
  entrypoint?: unknown;
  depends_on?: unknown;
  environment?: unknown;
};

const composeOf = (file: string): {
  services?: Record<string, Service>;
  volumes?: Record<string, unknown>;
} => parse(read(file)) as { services?: Record<string, Service>; volumes?: Record<string, unknown> };

/** Имена переменных сервиса — и в виде карты, и в виде списка «KEY=value». */
const envKeys = (environment: unknown): string[] => {
  if (Array.isArray(environment)) {
    return environment.map((entry) => String(entry).split('=')[0] ?? '');
  }
  if (environment && typeof environment === 'object') {
    return Object.keys(environment as Record<string, unknown>);
  }
  return [];
};

describe('the compose files manage no crawler and no database', () => {
  it.each(Object.entries(COMPOSE_FILES))(
    '%s declares only the storefront service',
    (file, storefront) => {
      const compose = composeOf(file);
      expect(Object.keys(compose.services ?? {}).sort()).toEqual([storefront]);
    },
  );

  it.each(Object.keys(COMPOSE_FILES))('%s has no depends_on', (file) => {
    const compose = composeOf(file);
    for (const [name, service] of Object.entries(compose.services ?? {})) {
      expect(
        service.depends_on,
        `${file}: the service '${name}' depends on something`,
      ).toBeUndefined();
    }
  });

  // Имя сервиса можно назвать как угодно: «backend», «helper», «sidecar».
  // Поэтому смотрим, что сервис *запускает* — образ, сборку, команду.
  it.each(Object.keys(COMPOSE_FILES))(
    '%s runs no crawler and no database',
    (file) => {
      const compose = composeOf(file);
      for (const [name, service] of Object.entries(compose.services ?? {})) {
        const where = `${file}: the service '${name}'`;
        expect(String(service.image ?? ''), `${where} runs a crawler image`).not.toMatch(FOREIGN);
        expect(JSON.stringify(service.build ?? ''), `${where} builds a crawler image`).not.toMatch(
          FOREIGN,
        );
        expect(String(service.command ?? ''), `${where} runs a crawler command`).not.toMatch(
          FOREIGN,
        );
        expect(String(service.entrypoint ?? ''), `${where} runs a crawler command`).not.toMatch(
          FOREIGN,
        );
        for (const key of envKeys(service.environment)) {
          expect(key, `${where} has the variable '${key}'`).not.toMatch(FOREIGN_ENV);
        }
      }
    },
  );

  // Том витрины — её дело. Запрещён том краулера: именно он и держал базу.
  it.each(Object.keys(COMPOSE_FILES))('%s has no volume of the crawler', (file) => {
    const compose = composeOf(file);
    for (const name of Object.keys(compose.volumes ?? {})) {
      expect(name, `${file}: the volume '${name}' belongs to the crawler`).not.toMatch(FOREIGN);
    }
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

  // Проба изнутри контейнера — единственная проверка маршрута до NetBird:
  // маршрут контейнера и маршрут хоста — разные. Она обязана быть и обязана
  // валить деплой.
  it('the deploy workflow probes the catalog API from inside the container', () => {
    const workflow = read('.github/workflows/deploy.yml');
    expect(workflow).toMatch(/docker exec product-catalog/);
    expect(workflow).toMatch(/X-Api-Key/);
    expect(workflow).toMatch(/cannot reach the catalog API[\s\S]*?exit 1/);
  });

  // Ключ не должен попасть в удалённый скрипт как текст: скрипт читается
  // сервером как shell, и `$(...)` в значении стал бы командой. Значение
  // едет закодированным и раскодируется на сервере, а в .env пишется в
  // одинарных кавычках — compose читает такое значение буквально.
  it('the deploy workflow never expands the key into the remote script', () => {
    const workflow = read('.github/workflows/deploy.yml');
    expect(workflow).toMatch(/base64 -w0/);
    expect(workflow).not.toMatch(/echo "CRAWLER_API_KEY=\$/);
    expect(workflow).toMatch(/CRAWLER_API_KEY='%s'/);
  });

  // У витрины нет базы, поэтому credential'а базы на её диске быть не должно:
  // деплой вычищает его из .env вместе с остальным. libpq пишет пароль в
  // переменные PG*, поэтому и они должны вычищаться — иначе ключ базы
  // остался бы на диске под другим именем.
  it('the deploy workflow leaves no database credential on the server', () => {
    const workflow = read('.github/workflows/deploy.yml');
    expect(workflow).toMatch(/DATABASE_URL/);
    expect(workflow).toMatch(/POSTGRES_/);
    expect(workflow).toMatch(/PG\[A-Z_\]/);
  });
});
