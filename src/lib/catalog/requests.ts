/**
 * Запросы витрины: что именно она спрашивает у каталога.
 *
 * Одно решение: **что спросить** — какой эндпоинт, с какими параметрами и с
 * каким бюджетом времени. Граница: краулер владеет базой, и единственный вход
 * в неё — его HTTP API только для чтения; как ответ превращается в то, что
 * рисует страница, — дело `mapping.ts`.
 */

import { ApiError, apiGet, CONNECT_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '../api/client';
import {
  buildItemsQuery,
  buildTopDealsQuery,
  normalizePaging,
  type ItemFilter,
  type Paging,
} from '../api/params';
import { DEFAULT_PAGE_SIZE, DEFAULT_SORT, type SortOrder } from '../api/sort';
import type {
  Paged,
  ProductCard,
  ProductDetail,
  SiteStats,
  TargetList,
  TargetSummary,
} from '../api/types';
import { mapCard, mapPage, mapPricePoint, mapSiteStats, mapTargetList } from './mapping';

/**
 * Бюджет на соединение для чтения каталога.
 *
 * Для запроса время ответа и есть время запроса — заголовки приходят, когда
 * SQL завершился, — а краулер вправе потратить на SQL восемь секунд, и
 * трёхсекундный бюджет обрывал бы работу, которую он вправе закончить. Собственный
 * таймаут краулера остаётся настоящим бюджетом, а этот — лишь затем, чтобы
 * запрос не висел вечно.
 */
const CATALOG_CONNECT_TIMEOUT_MS = REQUEST_TIMEOUT_MS;

/** Постраничный список карточек. Перевод словарей — в `src/lib/api/params.ts`. */
async function pagedCards(path: string, query: URLSearchParams): Promise<Paged<ProductCard>> {
  const page = await apiGet<Paged<ProductCard>>(path, {
    query,
    connectTimeoutMs: CATALOG_CONNECT_TIMEOUT_MS,
  });

  return { ...mapPage(page), items: (page.items ?? []).map(mapCard) };
}

/** Отфильтрованная, отсортированная, постраничная выборка карточек товаров. */
export async function listItems(options: {
  targetId?: string | undefined;
  filter?: ItemFilter | undefined;
  sort?: SortOrder | undefined;
  paging?: Paging | undefined;
}): Promise<Paged<ProductCard>> {
  const paging = normalizePaging(
    options.paging?.page ?? 0,
    options.paging?.pageSize ?? DEFAULT_PAGE_SIZE,
  );

  const query = buildItemsQuery({
    targetId: options.targetId,
    filter: options.filter,
    sort: options.sort ?? DEFAULT_SORT,
    paging,
  });

  return pagedCards('/items', query);
}

/**
 * Ответ о целях сбора целиком: и сами цели, и два момента ответа.
 *
 * ## Почему конверт, а не список
 *
 * Ответ `/targets` несёт наряду со списком `asOf`, `instanceId` и `dataAsOf`.
 * Список без конверта — это потерянный по дороге момент данных: страница
 * каталогов показывала бы список, не умея сказать, на какой момент он.
 *
 * ## Почему `listTargets` остаётся списком
 *
 * Список нужен там, где нужны сами цели (страница категории ищет по нему
 * цель, карта сайта — те, у которых есть данные), а конверт — там, где нужен
 * момент. Обе формы читаются одним запросом; различается только то, что
 * страница с ним делает.
 */
export async function getTargetList(): Promise<TargetList> {
  const body = await apiGet<TargetList>('/targets', {
    connectTimeoutMs: CATALOG_CONNECT_TIMEOUT_MS,
  });
  return mapTargetList(body);
}

/**
 * Все цели сбора вместе с количеством товаров в каждой.
 *
 * Количество товаров в цели считает сам краулер и кэширует у себя: сайт раньше
 * считал его через `LEFT JOIN` по всей таблице наблюдений, и это был единственный
 * запрос здесь, который не масштабировался сам собой.
 */
export async function listTargets(): Promise<TargetSummary[]> {
  const list = await getTargetList();
  return list.items;
}

/**
 * Один товар вместе с историей его цен.
 *
 * ## Почему неверный id — это `null`, а не ошибка
 *
 * Id приходит прямо из `/product/[id]`. Контракт говорит, что это UUID, и что
 * всё прочее — `400`; краулер раньше отвечал `22P02` от PostgreSQL, то есть
 * страницей ошибки базы для того, что на самом деле опечатка в URL. Поэтому и
 * `400`, и `404` отображаются здесь в `null`, и опечатка в id рисует страницу
 * «не найдено», а не страницу ошибки.
 */
export async function getProduct(id: string): Promise<ProductDetail | null> {
  try {
    const product = await apiGet<ProductDetail>(`/items/${encodeURIComponent(id)}`, {
      connectTimeoutMs: CATALOG_CONNECT_TIMEOUT_MS,
    });
    return {
      ...mapCard(product),
      history: (product.history ?? []).map(mapPricePoint),
      // Кто ответил и когда прочитаны данные — те же два поля, что и в
      // остальных ответах каталога. Краулер, который старше контракта, их не
      // присылает: пустая строка и null — это то, что страница рисует как «—».
      instanceId: product.instanceId ?? '',
      dataAsOf: product.dataAsOf ?? null,
    };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 400 || err.status === 404)) return null;
    throw err;
  }
}

/**
 * Наибольший кэшбэк по всем целям, одна строка на найденный товар.
 *
 * Дедупликация — дело краулера: он знает, какие строки описывают один и тот же
 * товар, и схлопывает их до лучшего наблюдения.
 */
export async function listTopDeals(options: {
  minCashbackPercent?: number | undefined;
  paging?: Paging | undefined;
}): Promise<Paged<ProductCard>> {
  const paging = normalizePaging(
    options.paging?.page ?? 0,
    options.paging?.pageSize ?? DEFAULT_PAGE_SIZE,
  );

  const query = buildTopDealsQuery({
    minCashbackPercent: options.minCashbackPercent,
    paging,
  });

  return pagedCards('/top-deals', query);
}

/** Счётчики по всему каталогу. */
export async function getSiteStats(): Promise<SiteStats> {
  const stats = await apiGet<SiteStats>('/stats', {
    connectTimeoutMs: CATALOG_CONNECT_TIMEOUT_MS,
  });

  return mapSiteStats(stats);
}

/**
 * Готов ли каталог к отдаче?
 *
 * Ответ приходит из собственной проверки готовности краулера, которая проверяет,
 * что его пул умеет выполнить запрос *и* что колонки, которые читает каталог,
 * на месте. Сайт раньше отвечал на этот вопрос запросом `SELECT 1 FROM
 * scraped_items LIMIT 1` — это более слабый вопрос: он говорит, что таблица
 * есть, а не что колонки, которые зовут запросы, тоже есть.
 *
 * Это никогда не бросает: проверка, которая бросает, уводит процесс за собой.
 */
export async function ping(): Promise<boolean> {
  try {
    // Из `apiGet` есть только выход через `2xx`, значит добраться до `return`
    // — значит проверка готовности ответила 200.
    await apiGet<{ status: string }>('/ready', {
      timeoutMs: CONNECT_TIMEOUT_MS,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
    });
    return true;
  } catch (err) {
    // Сообщение уже обрезано клиентом; сам объект ошибки не логируется, потому
    // что `cause` — не наше дело за него ручаться.
    const detail = err instanceof Error ? err.message : 'unknown error';
    console.error('[api] the catalog is not ready:', detail);
    return false;
  }
}
