/**
 * Каталоги и счётчики: что витрина говорит о составе каталога.
 *
 * ## Что здесь под тестом
 *
 * У витрины есть два представления о каталоге: список каталогов с числом
 * товаров в каждом и сводные счётчики. Они должны говорить одно и то же:
 * каталогов столько же, сколько в сводке, и ни один каталог не может
 * содержать больше товаров, чем их во всём каталоге.
 *
 * ## Про настроенный, но пустой каталог
 *
 * Каталог без товаров — это не ошибка, а состояние: он настроен, но данных в
 * нём ещё нет. Витрина обязана его показывать (иначе настройка молча
 * исчезает) и обязана отдавать по нему пустую страницу, а не ошибку.
 */

import { describe, expect, it } from 'vitest';
import { getSiteStats, listItems, listTargets } from '@/lib/queries';
import { useContractEnvironment } from './harness';

useContractEnvironment();

describe('каталоги и счётчики', () => {
  it('считает товары каждого каталога и не больше, чем их в каталоге', async () => {
    const targets = await listTargets();
    const stats = await getSiteStats();

    expect(targets).toHaveLength(stats.totalTargets);
    for (const target of targets) {
      expect(target.itemCount).toBeGreaterThanOrEqual(0);
      // В каталоге не может быть больше товаров, чем в каталоге.
      expect(target.itemCount).toBeLessThanOrEqual(stats.totalProducts);
    }

    // Каталоги считают товар один раз на каждый каталог, где он лежит: товар,
    // который лежит в трёх каталогах, — это три строки в трёх каталогах и один
    // товар. Поэтому сумма *больше* числа товаров, а число наблюдений цен —
    // больше ещё.
    expect(targets.reduce((sum, t) => sum + t.itemCount, 0)).toBeGreaterThanOrEqual(stats.totalProducts);
    expect(stats.totalItems).toBeGreaterThanOrEqual(stats.totalProducts);
  });

  it('показывает настроенный, но пустой каталог', async () => {
    const targets = await listTargets();
    const empty = targets.find((t) => t.itemCount === 0);
    expect(empty, 'the catalog should contain one configured-but-empty target').toBeDefined();
  });

  it('отдаёт пустую страницу каталогу без товаров', async () => {
    const targets = await listTargets();
    const empty = targets.find((t) => t.itemCount === 0)!;
    const page = await listItems({ targetId: empty.id, paging: { page: 0, pageSize: 24 } });
    expect(page.totalCount).toBe(0);
    expect(page.items).toEqual([]);
  });
});
