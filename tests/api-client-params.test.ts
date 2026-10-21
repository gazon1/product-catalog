/**
 * Параметры запроса: что именно витрина спрашивает у каталога.
 *
 * ## Что здесь под тестом
 *
 * Одно решение: **что спросить** — строка запроса в словаре API: имена
 * параметров, их порядок, единицы измерения и то, какие значения в неё попасть
 * не должны.
 *
 * ## Почему это отдельное решение
 *
 * Сайт говорит на своём языке (`minPriceRubles`), API — на своём (`minPrice`).
 * Перевод происходит ровно один раз, здесь; если он размазается по страницам, то
 * переименование параметра на стороне API станет переименованием на стороне
 * сайта. Ошибка в этом переводе — самая дорогая из возможных: фильтр, который
 * молча ничего не находит, выглядит как пустая выдача.
 *
 * ## Как это проверяется
 *
 * Прямо, без клиента: `buildItemsQuery` и `buildTopDealsQuery` — чистые
 * функции, и проверять их через сетевой слой значило бы проверять не их.
 * Второй блок — сквозная проверка того же через клиент: строка запроса должна
 * уехать именно такой, какой её собрали.
 */

import { describe, expect, it } from 'vitest';
import { apiGet } from '@/lib/api/client';
import { buildItemsQuery, buildTopDealsQuery, normalizePaging } from '@/lib/api/params';
import { DEFAULT_PAGE_SIZE, DEFAULT_SORT, MAX_PAGE_SIZE, SORT_ORDERS } from '@/lib/api/sort';
import { useClientHarness } from './api-client-harness';

const harness = useClientHarness();

describe('the query string the site sends for a list of items', () => {
  it('keeps the parameter order fixed', () => {
    // Строка запроса — не множество, и тест, который на неё смотрит, должен
    // уметь её предсказать. Сборщик, который дописывал бы параметры в порядке
    // вызова, сделал бы такой тест нестабильным без всякой пользы.
    const query = buildItemsQuery({
      targetId: '11111111-1111-4111-8111-111111111111',
      filter: {
        search: 'чайник',
        minPriceRubles: 100,
        maxPriceRubles: 5000,
        minCashbackPercent: 5,
        inStockOnly: true,
      },
      sort: 'PriceAsc',
      paging: { page: 0, pageSize: 24 },
    });

    expect(query.toString()).toBe(
      'targetId=11111111-1111-4111-8111-111111111111&q=%D1%87%D0%B0%D0%B9%D0%BD%D0%B8%D0%BA' +
        '&minPrice=100&maxPrice=5000&minCashback=5&inStock=true&sort=PriceAsc&page=0&pageSize=24',
    );
  });

  it('leaves out the parameters that carry no meaning', () => {
    // Отсутствующий фильтр — не фильтр нуля: `minPrice=0` спросил бы бесплатные
    // товары, а это другой вопрос, чем «нет минимума».
    const query = buildItemsQuery({});

    expect(query.get('sort')).toBe(DEFAULT_SORT);
    expect(query.get('page')).toBe('0');
    expect(query.get('pageSize')).toBe(String(DEFAULT_PAGE_SIZE));
    expect(query.has('minPrice')).toBe(false);
    expect(query.has('maxPrice')).toBe(false);
    expect(query.has('minCashback')).toBe(false);
    expect(query.has('inStock')).toBe(false);
    expect(query.has('q')).toBe(false);
  });

  it('sends minPrice and maxPrice as rubles, unchanged', () => {
    // Перевод в копейки происходит ровно один раз, внутри API. Сто здесь — это
    // сто рублей, а не десять тысяч.
    const query = buildItemsQuery({
      filter: { minPriceRubles: 199.99, maxPriceRubles: 1000 },
      paging: { page: 0, pageSize: 24 },
    });

    expect(query.get('minPrice')).toBe('199.99');
    expect(query.get('maxPrice')).toBe('1000');
    expect(query.toString()).not.toContain('19999');
  });

  it('sends the cashback filter as a percent', () => {
    const query = buildItemsQuery({
      filter: { minCashbackPercent: 15 },
      paging: { page: 0, pageSize: 24 },
    });
    expect(query.get('minCashback')).toBe('15');
  });

  it('sends the in-stock filter only when it is on', () => {
    // `inStock=false` был бы фильтром по отсутствующим в наличии товарам, а это
    // не то, что значит «только в наличии».
    const off = buildItemsQuery({ filter: { inStockOnly: false }, paging: { page: 0, pageSize: 24 } });
    expect(off.has('inStock')).toBe(false);

    const on = buildItemsQuery({ filter: { inStockOnly: true }, paging: { page: 0, pageSize: 24 } });
    expect(on.get('inStock')).toBe('true');
  });

  it('never sends a sort the API would reject', () => {
    // API отвечает `400` на имя, которого не знает, а `400` на открытой
    // странице — это сломанная страница.
    const query = buildItemsQuery({ sort: 'PriceDesc; DROP TABLE items' as never });
    expect(query.get('sort')).toBe(DEFAULT_SORT);
  });

  it('sends only declared sort names', () => {
    for (const sort of SORT_ORDERS) {
      const query = buildItemsQuery({ sort });
      expect(query.get('sort')).toBe(sort);
    }
  });

  it('sends the search term verbatim', () => {
    // `%` и `_` — буквальные символы в поиске API. Экранировать их здесь — значит
    // протащить диалект SQL сайта в строку запроса.
    const query = buildItemsQuery({
      filter: { search: '100%_off' },
      paging: { page: 0, pageSize: 24 },
    });
    expect(query.get('q')).toBe('100%_off');
  });
});

describe('the paging the site sends', () => {
  it('clamps a hostile page before it travels', () => {
    const paging = normalizePaging(-5, 100_000);
    expect(paging.page).toBe(0);
    expect(paging.pageSize).toBe(MAX_PAGE_SIZE);
  });

  it('falls back to the default size for a size that is not a number', () => {
    const paging = normalizePaging(0, Number.NaN);
    expect(paging.pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('falls back to the first page for a page that is not a number', () => {
    const paging = normalizePaging(Number.NaN, 24);
    expect(paging.page).toBe(0);
  });
});

describe('the query string the site sends for the top deals', () => {
  it('has no sort parameter', () => {
    // Контракт не определяет `sort` для этого списка: порядок «лучшего кэшбэка»
    // — это не выбор, а определение списка.
    const query = buildTopDealsQuery({
      minCashbackPercent: 15,
      paging: { page: 1, pageSize: 10 },
    });

    expect(query.toString()).toBe('minCashback=15&page=1&pageSize=10');
    expect(query.has('sort')).toBe(false);
  });
});

describe('the query string that actually leaves the site', () => {
  it('goes out in the order it was built in', async () => {
    await apiGet('/items', {
      query: buildItemsQuery({
        targetId: '11111111-1111-4111-8111-111111111111',
        filter: {
          search: 'чайник',
          minPriceRubles: 100,
          maxPriceRubles: 5000,
          minCashbackPercent: 5,
          inStockOnly: true,
        },
        sort: 'PriceAsc',
        paging: { page: 0, pageSize: 24 },
      }),
    });

    expect(harness.lastQuery()).toBe(
      'targetId=11111111-1111-4111-8111-111111111111&q=%D1%87%D0%B0%D0%B9%D0%BD%D0%B8%D0%BA' +
        '&minPrice=100&maxPrice=5000&minCashback=5&inStock=true&sort=PriceAsc&page=0&pageSize=24',
    );
  });

  it('leaves out the parameters that carry no meaning', async () => {
    await apiGet('/items', { query: buildItemsQuery({}) });

    expect(harness.lastQuery()).toBe('sort=DateDesc&page=0&pageSize=24');
  });

  it('sends the top-deals query without a sort', async () => {
    await apiGet('/top-deals', {
      query: buildTopDealsQuery({ minCashbackPercent: 15, paging: { page: 1, pageSize: 10 } }),
    });

    expect(harness.lastQuery()).toBe('minCashback=15&page=1&pageSize=10');
  });
});
