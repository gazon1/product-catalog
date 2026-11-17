/**
 * Гейт «граница постраничного отбора — это граница контракта».
 *
 * ## Что здесь под тестом
 *
 * Одно правило: **витрина отсекает страницы по той же границе, что и API**.
 *
 * Сайт зеркалит границу вручную — так же, как он зеркалит формы и имена
 * сортировок, — и именно этот тест следит, чтобы зеркало не разъехалось.
 * Граница решает, будет ли глубокая страница отсечена или отвергнута, и дрейф
 * здесь означал бы, что витрина просит страницу, которую API не отдаст, — и
 * показывает страницу, которую API не присылал.
 */

import { describe, expect, it } from 'vitest';
import { normalizePaging } from '@/lib/api/params';
import { DEFAULT_PAGE_SIZE, MAX_OFFSET, MAX_PAGE_SIZE, maxPageFor } from '@/lib/api/sort';
import { parseContractDocument } from '../global-setup';

/**
 * Граница смещения контракта — так, как её объявляет документ.
 */
function contractMaxOffset(): number {
  const document = parseContractDocument() as {
    'x-catalog-paging'?: { maxOffset?: number };
  };
  const value = document['x-catalog-paging']?.maxOffset;
  if (typeof value !== 'number') {
    throw new Error(
      'the contract document does not declare `x-catalog-paging.maxOffset`. The offset ' +
        'bound is part of the contract: the API clamps to it and the storefront clamps to it.',
    );
  }
  return value;
}

describe('the offset bound is the contract’s offset bound', () => {
  it('sends the bound the contract declares', () => {
    expect(MAX_OFFSET).toBe(contractMaxOffset());
  });

  it('bounds the page by the offset it produces, not by a page index', () => {
    // Граница зависит от размера страницы: база обходит все строки до нужной,
    // поэтому работа измеряется строками. Страница из шестидесяти строк и
    // страница из одной строки не могут ограничиваться одним и тем же индексом.
    expect(maxPageFor(60)).toBe(Math.floor(MAX_OFFSET / 60));
    expect(maxPageFor(1)).toBe(MAX_OFFSET);
    expect(maxPageFor(DEFAULT_PAGE_SIZE)).toBe(Math.floor(MAX_OFFSET / DEFAULT_PAGE_SIZE));
  });

  it('keeps the offset of every clamped page inside the bound', () => {
    // По всему диапазону размеров страницы, а не по двум выбранным вручную
    // случаям: отсечение, сработавшее для одного размера и не сработавшее для
    // другого, — это отсечение, которое не срабатывает на URL, который никто не
    // проверял.
    for (let pageSize = 1; pageSize <= MAX_PAGE_SIZE; pageSize += 1) {
      const paging = normalizePaging(99_999_999, pageSize);
      expect(paging.page * paging.pageSize).toBeLessThanOrEqual(MAX_OFFSET);
    }
  });
});

/**
 * Границы размера страницы контракта — так, как их объявляет документ.
 */
function contractPageSize(path: string): { minimum?: number; maximum?: number; default?: number } {
  const document = parseContractDocument() as {
    paths: Record<
      string,
      {
        get: {
          parameters: Array<{
            name: string;
            schema: { minimum?: number; maximum?: number; default?: number };
          }>;
        };
      }
    >;
  };
  const parameter = document.paths[path]?.get.parameters.find((p) => p.name === 'pageSize');
  if (!parameter) {
    throw new Error(`the contract document does not declare a \`pageSize\` parameter for ${path}`);
  }
  return parameter.schema;
}

describe('the page size is the contract’s page size', () => {
  it.each(['/items', '/top-deals'])('clamps to the size %s is served with', (path) => {
    // Отсечение на стороне витрины и отсечение на стороне API должны давать
    // один и тот же ответ: страница, которую витрина не прислала бы, — это
    // страница, которой API не отдавал.
    const bounds = contractPageSize(path);
    expect(bounds.maximum).toBe(MAX_PAGE_SIZE);
    expect(bounds.minimum).toBe(1);
    expect(normalizePaging(0, 1_000_000).pageSize).toBe(MAX_PAGE_SIZE);
    expect(normalizePaging(0, 0).pageSize).toBe(1);
  });

  it.each(['/items', '/top-deals'])('defaults to the size %s defaults to', (path) => {
    const bounds = contractPageSize(path);
    expect(bounds.default).toBe(DEFAULT_PAGE_SIZE);
    expect(normalizePaging(0, Number.NaN).pageSize).toBe(DEFAULT_PAGE_SIZE);
  });
});
