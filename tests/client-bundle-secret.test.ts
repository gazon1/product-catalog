/**
 * Ключ не должен попасть в браузерный бандл.
 *
 * ## Что здесь под тестом
 *
 * Одно правило: **ни один модуль, доступный из клиентского компонента, не
 * читает ключ.** Ключ живёт в `process.env.CRAWLER_API_KEY` на сервере и
 * уходит в заголовке `X-Api-Key`; в браузере ему делать нечего, а значение
 * `process.env.X` в клиентском бандле Next.js заменяется на `undefined` —
 * то есть ключ не утёк бы, но модуль всё равно попал бы в бандл целиком,
 * вместе с логикой разбора ключа.
 *
 * ## Почему это тест, а не проверка сборки
 *
 * Готовый бандл проверяет шаг деплоя (`/app/.next`, `/app/server.js`): там
 * ключ уже есть в окружении, и его нет в собранных файлах. Но шаг деплоя
 * случается один раз, а зависимость «клиентский компонент тянет серверный
 * модуль с ключом» может появиться в любом коммите. Тест ловит её на
 * исходниках: он идёт по графу импортов от `'use client'` и смотрит, что
 * в достижимых модулях нет чтения ключа.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');

/** Все модули исходников витрины. */
const sourceFiles = (): string[] => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(SRC);
  return files;
};

const read = (file: string): string => readFileSync(file, 'utf8');

/** Клиентский компонент: директива `'use client'` — первая директива файла. */
const isClientComponent = (source: string): boolean =>
  /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(source);

/** Спецификаторы импортов модуля. */
const importsOf = (source: string): string[] => {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
};

/** Разрешает спецификатор импорта в файл внутри `src`. */
const resolveSpecifier = (from: string, specifier: string): string | null => {
  const base = specifier.startsWith('@/')
    ? resolve(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(from), specifier)
      : null;
  if (!base) return null;

  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // не существует — пробуем следующий вариант
    }
  }
  return null;
};

/** Все модули, достижимые из клиентских компонентов по графу импортов. */
const clientReachableModules = (): Set<string> => {
  const reachable = new Set<string>();
  const queue: string[] = [];

  for (const file of sourceFiles()) {
    if (isClientComponent(read(file))) queue.push(file);
  }

  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || reachable.has(file)) continue;
    reachable.add(file);
    for (const specifier of importsOf(read(file))) {
      const next = resolveSpecifier(file, specifier);
      if (next && !reachable.has(next)) queue.push(next);
    }
  }

  return reachable;
};

describe('the key does not reach the browser bundle', () => {
  // Чтение ключа — это чтение переменной окружения и вызов помощника,
  // который её возвращает. Всё остальное с именем «CRAWLER_API_KEY» в коде
  // — обычный текст для человека.
  const READS_THE_KEY = /process\.env\.CRAWLER_API_KEY|\bapiSecret\s*\(/;

  it('finds the client components it starts from', () => {
    const clients = sourceFiles().filter((file) => isClientComponent(read(file)));
    expect(clients.length).toBeGreaterThan(0);
  });

  it('keeps the key out of every module a client component reaches', () => {
    const offenders: string[] = [];
    for (const file of clientReachableModules()) {
      const source = read(file);
      if (READS_THE_KEY.test(source)) {
        offenders.push(file.replace(`${ROOT}/`, ''));
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  // Тот же запрет — на готовом бандле: сборка образа отказывается собирать
  // клиентский чанк, который читает ключ. Проверка в сборке нужна, потому
  // что исходники читать нечем: клиентский чанк может прийти из модуля,
  // который никто из витрины не импортирует явно.
  it('makes the image build refuse a client bundle that reads the key', () => {
    const dockerfile = read(resolve(ROOT, 'Dockerfile'));
    expect(dockerfile).toMatch(/grep -rlF 'CRAWLER_API_KEY' \.next\/static\/chunks/);
    expect(dockerfile).toMatch(/exit 1/);
  });
});
