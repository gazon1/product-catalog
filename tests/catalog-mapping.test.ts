/**
 * Маппинг ответа: как ответ каталога становится тем, что показывает страница.
 *
 * ## Что здесь под тестом
 *
 * Одно решение: **как прочитать ответ**. API отдаёт необязательные поля и
 * `null`; страница хочет поле, которое всегда есть, и заглушку вместо пустого
 * заголовка.
 *
 * ## Почему это стоит проверять отдельно
 *
 * Маппинг — это место, где «поле есть, но оно пустое» превращается в `null`, а
 * `null` превращается в пустую строку на странице. Ошибка здесь не роняет
 * страницу: она тихо показывает «—» там, где должна была показать цену, и
 * заметить её можно только по тесту.
 */

import { describe, expect, it } from 'vitest';
import { mapCard, mapPage, mapPricePoint, mapSiteStats } from '@/lib/catalog/mapping';
import type { Paged, PricePoint, ProductCard, SiteStats } from '@/lib/api/types';

/** Карточка, у которой есть всё, кроме одной испорченной детали. */
function card(overrides: Partial<ProductCard> = {}): ProductCard {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    targetId: '22222222-2222-4222-8222-222222222222',
    targetName: 'Чайники',
    title: 'Чайник электрический',
    priceKopecks: 199990,
    salePriceKopecks: null,
    brand: 'Brand',
    seller: 'Seller',
    cashbackPercent: 12.5,
    cashbackRubles: 240,
    inStock: true,
    imageUrl: 'https://cdn.example.com/i.png',
    productUrl: 'https://www.wildberries.net/catalog/1/detail.aspx',
    scrapedAt: '2024-05-06T07:08:09Z',
    ...overrides,
  };
}

describe('the card as the page reads it', () => {
  it('keeps every field the API sent', () => {
    const mapped = mapCard(card());

    expect(mapped.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(mapped.title).toBe('Чайник электрический');
    expect(mapped.priceKopecks).toBe(199990);
    expect(mapped.cashbackRubles).toBe(240);
    expect(mapped.productUrl).toBe('https://www.wildberries.net/catalog/1/detail.aspx');
  });

  it('substitutes a title when the API sent none', () => {
    // Карточка без заголовка не рисуется ссылкой: пустой якорь невидим, а
    // страница невидимых ссылок — сломанная страница.
    const mapped = mapCard(card({ title: '' }));

    expect(mapped.title).toBe('Товар 11111111');
  });

  it('substitutes a title when the API sent only spaces', () => {
    const mapped = mapCard(card({ title: '   ' }));

    expect(mapped.title).toBe('Товар 11111111');
  });

  it('trims the title it keeps', () => {
    const mapped = mapCard(card({ title: '  Чайник  ' }));

    expect(mapped.title).toBe('Чайник');
  });

  it('turns the absent optional fields into explicit nulls', () => {
    // Страница сравнивает с `null`, а не с отсутствием: «поле есть, и оно
    // пустое» — это одно состояние, а «поля нет» — другое.
    const mapped = mapCard(
      card({
        priceKopecks: null,
        salePriceKopecks: null,
        brand: null,
        seller: null,
        cashbackPercent: null,
        cashbackRubles: null,
        inStock: null,
        imageUrl: null,
      }),
    );

    expect(mapped.priceKopecks).toBeNull();
    expect(mapped.salePriceKopecks).toBeNull();
    expect(mapped.brand).toBeNull();
    expect(mapped.seller).toBeNull();
    expect(mapped.cashbackPercent).toBeNull();
    expect(mapped.cashbackRubles).toBeNull();
    expect(mapped.inStock).toBeNull();
    expect(mapped.imageUrl).toBeNull();
  });
});

describe('the price point as the page reads it', () => {
  it('keeps the four fields it is made of', () => {
    const point: PricePoint = {
      scrapedAt: '2024-05-06T07:08:09Z',
      priceKopecks: 199990,
      cashbackPercent: 12.5,
      cashbackRubles: 240,
    };

    expect(mapPricePoint(point)).toEqual(point);
  });

  it('turns the absent optional fields into explicit nulls', () => {
    const point: PricePoint = {
      scrapedAt: '2024-05-06T07:08:09Z',
      priceKopecks: null,
      cashbackPercent: null,
      cashbackRubles: null,
    };

    const mapped = mapPricePoint(point);
    expect(mapped.priceKopecks).toBeNull();
    expect(mapped.cashbackPercent).toBeNull();
    expect(mapped.cashbackRubles).toBeNull();
  });
});

describe('the paged envelope as the page reads it', () => {
  it('keeps the counters the crawler sent', () => {
    const page: Paged<ProductCard> = {
      items: [card()],
      totalCount: 100,
      page: 2,
      pageSize: 24,
      totalPages: 5,
      hasNextPage: true,
      hasPrevPage: true,
    };

    expect(mapPage(page)).toEqual(page);
  });

  it('falls back to an empty page when the counters are missing', () => {
    const page = {} as Paged<ProductCard>;

    const mapped = mapPage(page);
    expect(mapped.items).toEqual([]);
    expect(mapped.totalCount).toBe(0);
    expect(mapped.page).toBe(0);
    expect(mapped.pageSize).toBe(0);
    expect(mapped.totalPages).toBe(0);
    expect(mapped.hasNextPage).toBe(false);
    expect(mapped.hasPrevPage).toBe(false);
  });
});

describe('the counters of the whole catalog as the page reads them', () => {
  it('keeps the counters the crawler sent', () => {
    const stats: SiteStats = {
      totalItems: 1000,
      totalProducts: 100,
      totalTargets: 5,
      newestScrapedAt: '2024-05-06T07:08:09Z',
      withCashback: 80,
      productsWithCashback: 20,
      asOf: '2024-05-06T07:08:09Z',
    };

    expect(mapSiteStats(stats)).toEqual(stats);
  });

  it('falls back to zero for the counters that are missing', () => {
    const stats = {} as SiteStats;

    const mapped = mapSiteStats(stats);
    expect(mapped.totalItems).toBe(0);
    expect(mapped.totalProducts).toBe(0);
    expect(mapped.totalTargets).toBe(0);
    expect(mapped.newestScrapedAt).toBeNull();
    expect(mapped.withCashback).toBe(0);
    expect(mapped.productsWithCashback).toBe(0);
  });

  it('falls back to an empty moment when the counters have none', () => {
    // Контракт делает момент обязательным, но витрина может ненадолго говорить с
    // краулером, который старше контракта, а пустая строка — это то, что
    // страница рисует как «—».
    const mapped = mapSiteStats({ asOf: undefined } as unknown as SiteStats);

    expect(mapped.asOf).toBe('');
  });
});
