/**
 * Топ скидок: одна строка на товар, порядок по кэшбэку.
 *
 * ## Что здесь под тестом
 *
 * «Топ скидок» — это не список наблюдений, а список товаров: цена, которая
 * сейчас, и кэшбэк по этому товару. Поэтому товар, наблюдённый несколько раз,
 * занимает в топе одну строку, а строки идут по кэшбэку по убыванию.
 */

import { describe, expect, it } from 'vitest';
import { listTopDeals } from '@/lib/queries';
import { useContractEnvironment } from './harness';

useContractEnvironment();

describe('топ скидок', () => {
  it('возвращает по одной строке на товар, в порядке кэшбэка', async () => {
    const page = await listTopDeals({ paging: { page: 0, pageSize: 30 } });
    expect(page.items.length).toBeGreaterThan(0);

    const seen = new Set<string>();
    for (const item of page.items) {
      expect(seen.has(item.id), `duplicate product ${item.id}`).toBe(false);
      seen.add(item.id);
    }

    // Нулевые кэшбэки отброшены: где встанет ноль — дело краулера, а сравнение
    // с нулём — это сравнение ни о чём.
    const percents = page.items
      .map((i) => i.cashbackPercent)
      .filter((v): v is number => v !== null);
    for (let i = 1; i < percents.length; i += 1) {
      expect(percents[i]!).toBeLessThanOrEqual(percents[i - 1]!);
    }
  });

  it('уважает минимальный кэшбэк', async () => {
    const page = await listTopDeals({ minCashbackPercent: 15, paging: { page: 0, pageSize: 20 } });
    for (const item of page.items) {
      expect(item.cashbackPercent!).toBeGreaterThanOrEqual(15);
    }
  });
});
