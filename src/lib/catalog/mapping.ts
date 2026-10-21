/**
 * Маппинг ответа: как ответ каталога становится тем, что показывает страница.
 *
 * ## Что здесь решается
 *
 * Одно решение: **как прочитать ответ**. API отдаёт то, что у него есть, — со
 * своими необязательными полями и своими `null`. Страница хочет другое: поле,
 * которое всегда есть, и заглушку вместо пустого заголовка. Перевод между
 * этими двумя словарями — здесь, и больше нигде.
 *
 * ## Почему у сайта своя заглушка
 *
 * Контракт обещает непустой заголовок, поэтому против правильного API это не
 * срабатывает ни разу. Оно остаётся потому, что карточка без заголовка не
 * отрисуется ссылкой: пустой якорь не виден, а страница невидимых ссылок —
 * это сломанная страница. Второй слой согласен с первым на одну и ту же
 * заглушку, поэтому это вторая линия обороны, а не второй источник истины.
 *
 * ## Счётчики — краулера
 *
 * Сколько строк совпало до постраничного отсечения — знает краулер, и второй
 * подсчёт здесь был бы вторым запросом и вторым шансом не согласиться с
 * первым.
 */

import type { Paged, PricePoint, ProductCard, SiteStats } from '../api/types';

/**
 * Применить собственную заглушку сайта к заголовку, которого не дал API.
 *
 * Контракт обещает непустой заголовок, поэтому против правильного API это не
 * срабатывает. Заглушка нужна для того, чтобы карточка без заголовка не
 * превратилась в невидимый якорь.
 */
export function mapCard(card: ProductCard): ProductCard {
  return {
    id: card.id,
    targetId: card.targetId,
    targetName: card.targetName,
    title: card.title?.trim() || `Товар ${String(card.id ?? '').slice(0, 8)}`,
    priceKopecks: card.priceKopecks ?? null,
    salePriceKopecks: card.salePriceKopecks ?? null,
    brand: card.brand ?? null,
    seller: card.seller ?? null,
    cashbackPercent: card.cashbackPercent ?? null,
    cashbackRubles: card.cashbackRubles ?? null,
    inStock: card.inStock ?? null,
    imageUrl: card.imageUrl ?? null,
    productUrl: card.productUrl,
    scrapedAt: card.scrapedAt,
  };
}

/** Одно наблюдение цены, так, как его читают страницы. */
export function mapPricePoint(point: PricePoint): PricePoint {
  return {
    scrapedAt: point.scrapedAt,
    priceKopecks: point.priceKopecks ?? null,
    cashbackPercent: point.cashbackPercent ?? null,
    cashbackRubles: point.cashbackRubles ?? null,
  };
}

/**
 * Конверт постраничного ответа — с осторожностью.
 *
 * Счётчики принадлежат краулеру, а не нам: краулер знает, сколько строк
 * совпало до отсечения, и второй подсчёт здесь был бы вторым запросом и вторым
 * шансом не согласиться с первым.
 */
export function mapPage<T>(page: Paged<T>): Paged<T> {
  return {
    items: page.items ?? [],
    totalCount: page.totalCount ?? 0,
    page: page.page ?? 0,
    pageSize: page.pageSize ?? 0,
    totalPages: page.totalPages ?? 0,
    hasNextPage: page.hasNextPage ?? false,
    hasPrevPage: page.hasPrevPage ?? false,
  };
}

/**
 * Счётчики по всему каталогу, так, как их рисует страница.
 *
 * Момент, в который посчитаны счётчики, контракт делает обязательным, и он
 * обязательным — но витрина может ненадолго говорить с краулером, который
 * старше контракта, а пустая строка — это то, что страница рисует как «—».
 */
export function mapSiteStats(stats: SiteStats): SiteStats {
  return {
    totalItems: stats.totalItems ?? 0,
    totalProducts: stats.totalProducts ?? 0,
    totalTargets: stats.totalTargets ?? 0,
    newestScrapedAt: stats.newestScrapedAt ?? null,
    withCashback: stats.withCashback ?? 0,
    productsWithCashback: stats.productsWithCashback ?? 0,
    asOf: stats.asOf ?? '',
  };
}
