/**
 * Гейт «страница показывает момент своих данных».
 *
 * ## Что здесь под тестом
 *
 * Одно правило: **у каждой страницы подвал показывает момент данных той
 * страницы**, а не момент счётчиков.
 *
 * ## Почему это гейт, а не тест компонента
 *
 * Компонент в этом репозитории не рендерят: страницы собираются в разметку на
 * сервере, а тесты живут на чистых функциях и на исходниках. Поэтому правило
 * проверяется там, где оно и может сломаться, — в разметке страницы: каждый
 * файл, который рисует страницу, обязан передать подвалу `dataAsOf`.
 *
 * ## Что именно ловится
 *
 *   - страница, которая забыла про момент: подвал рисует «—» там, где данные
 *     есть, и посетитель не знает, насколько свежие они;
 *   - страница, которая отдала подвалу `asOf`: подпись «данные на …» над
 *     моментом чтения кэша — это обещание свежести, которой нет;
 *   - блок счётчиков, где моменты перепутаны местами.
 *
 * Счётчики и данные — разные вещи (см. ADR краулера
 * `2026-10-20-the-counters-measure-different-things.md`), и гейт следит за
 * тем, чтобы подписи не разъехались.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from './source-scan';

/** Корень страниц витрины. */
const APP_DIR = resolve(__dirname, '..', '..', 'src', 'app');

/** Файлы, которые рисуют страницу целиком. */
const PAGE_FILES = ['page.tsx', 'error.tsx', 'not-found.tsx'];

/** Собирать файлы страниц. */
function pageFiles(): string[] {
  const found: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (PAGE_FILES.includes(entry.name)) found.push(full);
    }
  }

  walk(APP_DIR);
  return found.sort();
}

/** Исходник файла без комментариев. */
function source(file: string): string {
  return stripComments(readFileSync(file, 'utf8'));
}

/** Открывающие теги `<SiteFooter ...>` в исходнике. */
function footerTags(code: string): string[] {
  return code.match(/<SiteFooter\b[^>]*>/g) ?? [];
}

describe('every page shows the moment of its own data', () => {
  const files = pageFiles();

  it('finds the pages to check', () => {
    // Пустой список означал бы, что гейт проверяет пустоту и зелёный.
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const name = file.slice(APP_DIR.length + 1);

    it(`${name} renders the footer with the moment of the data`, () => {
      const tags = footerTags(source(file));

      expect(tags.length, 'the page must render the footer').toBeGreaterThan(0);
      expect(
        tags.some((tag) => tag.includes('dataAsOf=')),
        'the footer must be given the moment of the data (dataAsOf)'
      ).toBe(true);
    });

    it(`${name} does not show the counters moment as the moment of the data`, () => {
      const tags = footerTags(source(file));

      // `asOf` — это момент чтения кэша счётчиков. Подписать его «данные
      // на …» — значит соврать о свежести.
      for (const tag of tags) {
        expect(/(?<!data)asOf=/.test(tag), `the footer must not take asOf: ${tag}`).toBe(false);
        expect(/dataAsOf=\{[^}]*\.asOf\}/.test(tag), `the footer must not take a counters moment: ${tag}`).toBe(
          false
        );
      }
    });
  }
});

describe('the block of counters names both moments', () => {
  const summary = resolve(__dirname, '..', '..', 'src', 'components', 'CatalogSummary.tsx');
  const code = source(summary);

  it('takes the counters moment for `asOf`', () => {
    expect(/countersAsOfMoment\(\s*stats\.asOf\s*\)/.test(code)).toBe(true);
  });

  it('takes the data moment for `dataAsOf`', () => {
    expect(/dataAsOfMoment\(\s*stats\.dataAsOf\s*\)/.test(code)).toBe(true);
  });

  it('never swaps them', () => {
    expect(/dataAsOfMoment\(\s*stats\.asOf\s*\)/.test(code)).toBe(false);
    expect(/countersAsOfMoment\(\s*stats\.dataAsOf\s*\)/.test(code)).toBe(false);
  });
});

describe('the footer names the moment of the data', () => {
  it('takes it from the data moment, not from the counters one', () => {
    const code = source(resolve(__dirname, '..', '..', 'src', 'components', 'SiteFooter.tsx'));

    expect(/dataAsOfMoment\(/.test(code)).toBe(true);
    expect(/countersAsOfMoment\(/.test(code)).toBe(false);
  });
});
