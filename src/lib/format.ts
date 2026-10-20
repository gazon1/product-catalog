/**
 * Small presentation helpers shared across pages.
 *
 * They live here rather than in a page because they are pure functions with
 * non-obvious rules — Russian plural selection and failure mapping — and a
 * function buried in `page.tsx` is one nothing imports and therefore nothing
 * tests.
 */

/** Russian plural selection: "1 товар", "2 товара", "5 товаров". */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  // 11–14 take the many-form even though mod10 is 1..4, so this check comes first.
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * Turn a failure into something a visitor can read.
 *
 * The detail stays in the server log; the page gets a sentence that says whether
 * retrying could help. Silently rendering an empty catalog on a failure would be
 * the worst outcome available — it looks exactly like "the crawler has not run
 * yet".
 *
 * The failures this maps are the ones the catalog API can produce. The storefront
 * has no database of its own any more, so "the database refused the connection"
 * is not a thing that can happen here: what can happen is that the API is not
 * configured, that it is unreachable, that it refused the key, or that it said
 * the catalog cannot be served.
 */
export function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  if (/CRAWLER_API_URL/.test(message)) {
    return 'Не задан адрес API каталога (CRAWLER_API_URL). Сайт не может прочитать каталог.';
  }
  if (/CRAWLER_API_KEY/.test(message)) {
    return 'Не задан ключ доступа к API каталога (CRAWLER_API_KEY). Сайт не может прочитать каталог.';
  }
  if (/answered 401/.test(message) || /unauthorized/i.test(message)) {
    return 'API каталога отклонило ключ. Проверьте CRAWLER_API_KEY: он должен совпадать с CATALOG_API_KEY краулера.';
  }
  if (/answered 503/.test(message)) {
    return 'Каталог временно недоступен: краулер не может его отдать. Проверьте состояние базы краулера.';
  }
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|unreachable/i.test(message)) {
    return 'API каталога недоступно. Проверьте, что краулер запущен и принимает подключения.';
  }
  return 'Подробности — в логах сервера.';
}
