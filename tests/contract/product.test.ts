/**
 * Страница товара: история наблюдений и её границы.
 *
 * ## Что здесь под тестом
 *
 * Товар — это карточка плюс история: сколько он стоил и когда. История
 * принадлежит товару, а не каталогу, и проверяется именно это: наблюдения
 * одного товара не должны смешиваться с наблюдениями другого каталога, а
 * неизвестный или испорченный идентификатор должен давать «нет такого», а не
 * ошибку.
 */

import { describe, expect, it } from 'vitest';
import { getProduct, listItems, listTargets } from '@/lib/queries';
import { useContractEnvironment } from './harness';

useContractEnvironment();

describe('страница товара', () => {
  it('возвращает товар с историей цен, от новых к старым', async () => {
    const targets = await listTargets();

    // Список — это список *товаров*: по одной карточке на товар, с текущей
    // ценой. Товар, который наблюдали несколько раз, — всё равно одна карточка,
    // а его наблюдения лежат в истории, — вот там тест и смотрит.
    //
    // Сначала самые старые, потому что товар с историей — тот, который
    // наблюдали первым, и сид краулера кладёт его в начало порядка. Где именно
    // он стоит — дело краулера; тест настаивает лишь на том, что *какая-то*
    // карточка ведёт к истории длиннее одной записи.
    let product: Awaited<ReturnType<typeof getProduct>> = null;
    for (const target of targets) {
      const chunk = await listItems({
        targetId: target.id,
        sort: 'DateAsc',
        paging: { page: 0, pageSize: 30 },
      });
      for (const item of chunk.items) {
        const candidate = await getProduct(item.id);
        if (candidate && candidate.history.length > 1) {
          product = candidate;
          break;
        }
      }
      if (product) break;
    }

    expect(product, 'the catalog should contain a product with several observations').not.toBeNull();
    expect(product!.history.length).toBeGreaterThan(1);

    for (let i = 1; i < product!.history.length; i += 1) {
      expect(product!.history[i]!.scrapedAt <= product!.history[i - 1]!.scrapedAt).toBe(true);
    }
  });

  it('не смешивает историю товара между каталогами', async () => {
    // Какие товары у каждого каталога. Товар, который лежит в двух каталогах,
    // — и есть интересный случай: история, перешагнувшая границу, держала бы
    // и наблюдения другого каталога.
    //
    // Список считает *товары*, а не наблюдения: по одной карточке на товар с
    // его текущей ценой, — поэтому счётчики говорят, в скольких каталогах
    // товар лежит, а наблюдения лежат в историях.
    const targets = await listTargets();
    const itemOf = new Map<string, Map<string, string>>();
    for (const target of targets) {
      const ids = new Map<string, string>();
      for (let page = 0; ; page += 1) {
        const chunk = await listItems({ targetId: target.id, paging: { page, pageSize: 60 } });
        for (const item of chunk.items) {
          if (!ids.has(item.title)) ids.set(item.title, item.id);
        }
        if (chunk.items.length < 60) break;
      }
      itemOf.set(target.id, ids);
    }

    // Один товар, который лежит больше чем в одном каталоге, и каталоги, где
    // он лежит. Товар берётся из обхода выше, а не с первой страницы: где
    // товар стоит в порядке — дело краулера.
    let shared: { title: string; targets: string[] } | undefined;
    for (const target of targets) {
      for (const title of itemOf.get(target.id)!.keys()) {
        const elsewhere = targets.filter((other) => itemOf.get(other.id)!.has(title));
        if (elsewhere.length < 2) continue;
        shared = { title, targets: elsewhere.map((other) => other.id) };
        break;
      }
      if (shared) break;
    }

    expect(
      shared,
      'the catalog should contain a product that appears in more than one target',
    ).toBeDefined();

    // История этого товара, взятая через карточку каждого каталога.
    const histories: string[][] = [];
    for (const targetId of shared!.targets) {
      const itemId = itemOf.get(targetId)!.get(shared!.title)!;
      const product = await getProduct(itemId);
      expect(product).not.toBeNull();
      histories.push(product!.history.map((point) => point.scrapedAt));
    }

    // История каждого каталога должна держать свои наблюдения и не чужие.
    // Объединение историй — это то, что держит краулер; история, перешагнувшая
    // границу, была бы всем объединением поодиночке.
    const union = new Set(histories.flat());
    for (const history of histories) {
      expect(
        history.length,
        'the history holds observations from another target',
      ).toBeLessThan(union.size);
    }
  });

  it('возвращает null для неизвестного id', async () => {
    expect(await getProduct('00000000-0000-4000-a000-000000000000')).toBeNull();
  });

  it('возвращает null для испорченного id, а не бросает', async () => {
    // Идентификатор приходит прямо из URL.
    await expect(getProduct('not-a-uuid')).resolves.toBeNull();
  });
});
