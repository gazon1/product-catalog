/**
 * Small presentation helpers shared across pages.
 *
 * They live here rather than in a page because they are pure functions with
 * non-obvious rules — Russian plural selection and driver-error mapping — and a
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
 * Turn a driver/connection error into something a visitor can read.
 *
 * The detail stays in the server log; the page gets a sentence that says whether
 * retrying could help. Silently rendering an empty catalog on a connection
 * failure would be the worst outcome available — it looks exactly like "the
 * crawler has not run yet".
 */
export function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/DATABASE_URL/.test(message)) {
    return 'Не задано подключение к базе данных (DATABASE_URL). Сайт не может прочитать каталог.';
  }
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(message)) {
    return 'База данных недоступна. Проверьте, что она запущена и принимает подключения.';
  }
  if (/password authentication|database .* does not exist/.test(message)) {
    return 'База данных отклонила подключение. Проверьте DATABASE_URL и права пользователя.';
  }
  return 'Подробности — в логах сервера.';
}