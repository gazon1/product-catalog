/**
 * Страница и порядок: что витрина просит и что API отдаёт.
 *
 * ## Что здесь под тестом
 *
 * Страница — это окно каталога, и у неё есть обещания: элементы не
 * повторяются и не теряются между страницами, `total` правдив, а враждебная
 * страница (`-5`, `100000`) не ломает ни сайт, ни API. Порядок — второе
 * обещание: «по кэшбэку по убыванию» значит именно по кэшбэку по убыванию.
 *
 * ## Почему проверяются обе стороны
 *
 * Сайт и API решают одно и то же по-разному: сайт строит запрос, API отвечает
 * своим способом, и если один из двух не согласен с контрактом, страница
 * показывает не то. Поэтому здесь проверяется и то, что *сайт* отправил, и то,
 * что *API* ответил, и что эти два совпали.
 */

import { describe, expect, it } from 'vitest';
import { apiGet } from '@/lib/api/client';
import { buildItemsQuery, normalizePaging } from '@/lib/api/params';
import { MAX_OFFSET } from '@/lib/api/sort';
import { listItems } from '@/lib/queries';
import { MAX_PAGE_SIZE } from '@/lib/types';
import { useContractEnvironment } from './harness';

useContractEnvironment();

describe('страница', () => {
  it('не повторяет и не теряет элементы между страницами', async () => {
    const first = await listItems({ paging: { page: 0, pageSize: 20 } });
    const second = await listItems({ paging: { page: 1, pageSize: 20 } });

    const firstIds = new Set(first.items.map((i) => i.id));
    expect(second.items).toHaveLength(20);
    for (const item of second.items) {
      expect(firstIds.has(item.id), `page 2 repeated ${item.id}`).toBe(false);
    }
  });

  it('сообщает правдивое количество', async () => {
    const pageSize = 60;
    const first = await listItems({ paging: { page: 0, pageSize } });

    const seen = new Set<string>();
    let collected = 0;
    for (let page = 0; page < first.totalPages; page += 1) {
      const current = await listItems({ paging: { page, pageSize } });
      for (const item of current.items) {
        expect(seen.has(item.id), `the same item came back twice: ${item.id}`).toBe(false);
        seen.add(item.id);
        collected += 1;
      }
    }

    expect(collected).toBe(first.totalCount);
    expect(first.totalPages).toBe(Math.ceil(first.totalCount / pageSize));
  });

  it('зажимает враждебную страницу вместо того, чтобы сломаться', async () => {
    const page = await listItems({ paging: { page: -5, pageSize: 100_000 } });
    expect(page.page).toBe(0);
    expect(page.pageSize).toBe(MAX_PAGE_SIZE);
    expect(page.items.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
  });

  it('никогда не отправляет страницу, которую API отверг бы', async () => {
    // API зажимает враждебную страницу в диапазон, который он отдаёт, — так
    // говорит контракт, а `400` оставлен для параметра, который API истолковать
    // не может вовсе (не UUID, не имя сортировки).
    //
    // Зажим самого сайта всё равно нужен: обычный URL сайта не должен просить
    // страницу, которой нет, и сайт и API должны зажимать одно и то же.
    const body = await apiGet<{ page: number; pageSize: number }>('/items', {
      query: new URLSearchParams({ page: '-1', pageSize: '24' }),
    });
    expect(body.page).toBe(0);
    expect(body.pageSize).toBe(24);

    // И собственный построитель запроса никогда не отправляет враждебное
    // значение вовсе.
    expect(buildItemsQuery({ paging: { page: -5, pageSize: 24 } }).get('page')).toBe('0');
  });

  it('зажимает глубокую страницу по смещению, а не по номеру', async () => {
    // Предел — на смещении (`page x pageSize`), потому что это платит база:
    // она проходит все строки до той страницы. Глубокая страница поэтому
    // зажимается на последней, которая в предел помещается, и отдаётся
    // страницами этой страницы, а не ошибкой.
    //
    // Сайт зажимает в то же число, из того же контракта: витрина, зажавшая
    // другую страницу, показала бы страницу, которую API не присылал.
    const pageSize = 60;
    const expected = Math.floor(MAX_OFFSET / pageSize);

    const body = await apiGet<{ page: number; pageSize: number }>('/items', {
      query: new URLSearchParams({ page: '99999999', pageSize: String(pageSize) }),
    });
    expect(body.page).toBe(expected);
    expect(body.page * body.pageSize).toBeLessThanOrEqual(MAX_OFFSET);

    // Зажим сайта совпадает с ответом API.
    const site = normalizePaging(99_999_999, pageSize);
    expect(site.page).toBe(body.page);
    expect(buildItemsQuery({ paging: { page: 99_999_999, pageSize } }).get('page')).toBe(
      String(expected),
    );
  });
});

describe('порядок', () => {
  it('сортирует по кэшбэку по убыванию, когда просят', async () => {
    const page = await listItems({ sort: 'CashbackPercentDesc', paging: { page: 0, pageSize: 30 } });
    const percents = page.items
      .map((i) => i.cashbackPercent)
      .filter((v): v is number => v !== null);

    expect(percents.length).toBeGreaterThan(0);
    for (let i = 1; i < percents.length; i += 1) {
      expect(percents[i]!).toBeLessThanOrEqual(percents[i - 1]!);
    }
  });
});
