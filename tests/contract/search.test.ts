/**
 * Поиск и фильтры: как витрина ищет и как сужает каталог.
 *
 * ## Что здесь под тестом
 *
 * Поиск и фильтры — это собственный словарь витрины: «найти по слову
 * названия», «от ста рублей», «не больше пятидесяти», «кэшбэк не меньше
 * одного процента». Каждый из них обещает, что найденное действительно
 * подходит под условие, а не просто «что-то вернулось».
 *
 * ## Почему `%` и `_` проверяются отдельно
 *
 * Незакрытые `%` и `_` в поиске означают «любой символ» и «один символ»,
 * и поиск выродился бы в «вернуть всё». Слово с ними — это слово, а не
 * шаблон, и проверка говорит об этом прямо.
 */

import { describe, expect, it } from 'vitest';
import { listItems } from '@/lib/queries';
import { effectivePriceKopecks, searchHaystack, useContractEnvironment } from './harness';

useContractEnvironment();

describe('поиск', () => {
  it('находит товар по слову названия', async () => {
    const all = await listItems({ paging: { page: 0, pageSize: 30 } });
    const word = all.items
      .flatMap((item) => item.title.split(/\s+/))
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
      .find((w) => w.length >= 4);

    expect(word, 'the catalog should contain a product with a word in its title').toBeDefined();

    const page = await listItems({ filter: { search: word! }, paging: { page: 0, pageSize: 30 } });
    expect(page.totalCount).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(searchHaystack(item)).toContain(word!.toLowerCase());
    }
  });

  it('понимает % и _ как обычные символы', async () => {
    // Незакрытый `%` соответствует чему угодно, а `_` — одному символу, и
    // поиск выродился бы в «вернуть всё».
    const all = await listItems({ paging: { page: 0, pageSize: 30 } });
    const word = all.items
      .flatMap((item) => item.title.split(/\s+/))
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
      .find((w) => w.length >= 4);
    expect(word).toBeDefined();

    const literal = await listItems({ filter: { search: `${word!}%` }, paging: { page: 0, pageSize: 30 } });
    const plain = await listItems({ filter: { search: word! }, paging: { page: 0, pageSize: 30 } });

    expect(literal.totalCount).toBeLessThanOrEqual(plain.totalCount);
    for (const item of literal.items) {
      expect(searchHaystack(item)).toContain(`${word!.toLowerCase()}%`);
    }

    const underscore = await listItems({ filter: { search: '_' }, paging: { page: 0, pageSize: 30 } });
    for (const item of underscore.items) {
      expect(searchHaystack(item)).toContain('_');
    }
  });
});

describe('фильтры по цене', () => {
  it('применяет нижнюю границу в рублях к действующей цене', async () => {
    const page = await listItems({
      filter: { minPriceRubles: 100 },
      paging: { page: 0, pageSize: 40 },
    });

    for (const item of page.items) {
      const effective = effectivePriceKopecks(item);
      if (effective !== null) {
        expect(effective / 100, `${item.title} is cheaper than the bound`).toBeGreaterThanOrEqual(100);
      }
    }
  });

  it('применяет верхнюю границу в рублях тоже', async () => {
    const page = await listItems({
      filter: { maxPriceRubles: 50 },
      paging: { page: 0, pageSize: 40 },
    });

    for (const item of page.items) {
      const effective = effectivePriceKopecks(item);
      if (effective !== null) {
        expect(effective / 100, `${item.title} is dearer than the bound`).toBeLessThanOrEqual(50);
      }
    }
  });

  it('никогда не обещает кэшбэк больше самого товара', async () => {
    // Краулер хранит кэшбэк в рублях, а цену — в копейках. Прочитанное не так
    // показывается как семизначный кэшбэк на чайнике за 40 000 ₽.
    const page = await listItems({
      filter: { minCashbackPercent: 1 },
      sort: 'CashbackPercentDesc',
      paging: { page: 0, pageSize: 25 },
    });

    for (const item of page.items) {
      expect(item.cashbackPercent).not.toBeNull();
      if (item.cashbackRubles !== null) {
        const price = effectivePriceKopecks(item);
        expect(item.cashbackRubles).toBeLessThanOrEqual((price ?? Infinity) / 100);
      }
    }
  });
});
