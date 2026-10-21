/**
 * Гейт «словарь сортировки — это словарь контракта».
 *
 * ## Что здесь под тестом
 *
 * Одно правило: **набор имён сортировки закрыт и совпадает с контрактом**.
 *
 * Имена сортировки принадлежат сайту, а реализация — API, и они согласуются
 * только если кто-то это проверяет. Проверка здесь, а не в контрактном тесте,
 * потому что этот файл должен запускаться без краулера: закрытый набор,
 * разъехавшийся с контрактом, отправил бы имя, которое API отвергнет, и обычный
 * URL сайта стал бы `400`.
 */

import { describe, expect, it } from 'vitest';
import { SORT_ORDERS } from '@/lib/api/sort';
import { isSortOrder } from '@/lib/types';
import { parseContractDocument } from '../global-setup';

/**
 * Перечисление `sort` контракта — так, как его объявляет документ.
 */
function contractSortEnum(): string[] {
  const document = parseContractDocument() as {
    paths: Record<
      string,
      { get: { parameters: Array<{ name: string; schema: { enum?: string[] } }> } }
    >;
  };
  const parameter = document.paths['/items']?.get.parameters.find((p) => p.name === 'sort');
  const values = parameter?.schema.enum;
  if (!values) {
    throw new Error('the contract document does not declare a `sort` enum for /items');
  }
  return values;
}

describe('sort order is a closed set', () => {
  it('accepts only declared values', () => {
    for (const order of SORT_ORDERS) {
      expect(isSortOrder(order)).toBe(true);
    }
  });

  it('rejects anything else from a URL', () => {
    // Это то, что не даёт `?sort=` дойти до API. Тип-объединение останавливает
    // его в компиляторе; это останавливает его во время выполнения, там, где
    // значение на самом деле и появляется.
    expect(isSortOrder('PriceDesc; DROP TABLE scraped_items')).toBe(false);
    expect(isSortOrder('scraped_at DESC')).toBe(false);
    expect(isSortOrder('')).toBe(false);
    expect(isSortOrder(null)).toBe(false);
    expect(isSortOrder(undefined)).toBe(false);
  });
});

describe('the sort names are the contract’s sort enum', () => {
  it('sends exactly the names the contract accepts', () => {
    expect([...SORT_ORDERS].sort()).toEqual([...contractSortEnum()].sort());
  });

  it('sends no name that the contract would reject', () => {
    const allowed = new Set(contractSortEnum());
    for (const order of SORT_ORDERS) {
      expect(allowed.has(order), `the site sends "${order}", which the contract does not declare`).toBe(
        true,
      );
    }
  });
});
