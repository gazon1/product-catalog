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
