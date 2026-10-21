/**
 * Разбор ответа: как прочитать то, что пришло.
 *
 * ## Что здесь решается
 *
 * Один вопрос: **что означает пришедшее**. Модуль разбирает тело в структуру и
 * превращает неудачный ответ в {@link ApiError}, который вызывающий может
 * показать, залогировать или разобрать по частям.
 *
 * ## Что в ошибке
 *
 * Код ответа и разобранное тело — вместе они обычно и есть весь диагноз: `400`
 * говорит, какой параметр неверен, `401` — что неверен ключ, `503` — что
 * каталог сейчас не отдаётся.
 *
 * Идентификатор запроса — последнее в сообщении, потому что он и есть ручка ко
 * всему остальному в нём: именно он превращает «каталог ответил 503» в вопрос,
 * на который журнал краулера отвечает.
 *
 * ## Почему тело, которое не JSON, — тоже полезно
 *
 * HTML-страница ошибки от прокси говорит больше, чем голый код ответа, поэтому
 * не-JSON тело сохраняется как есть, а не выбрасывается.
 */

import { requestWithRetry } from './retry';
import { ApiError, apiSecret, redact } from './error';
import type { ApiRequestOptions } from './transport';

/**
 * Разобрать тело ответа как JSON, а если не вышло — оставить как есть.
 *
 * Тело, которое не является JSON, — всё равно улика: HTML-страница ошибки от
 * прокси говорит о чём-то таком, чего не говорит голый код ответа.
 */
export function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Сообщение для ответа, который не `2xx`.
 *
 * Собственное поле `error` от API цитируется, когда оно есть: «ключ не
 * подходит» — это фраза, с которой оператор может что-то сделать, а голый `401`
 * — нет.
 */
export function failureMessage(
  status: number,
  body: unknown,
  path: string,
  requestId: string,
): string {
  const detail =
    body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? `: ${body.error}`
      : '';
  return `the catalog API answered ${status} for ${path}${detail} (request ${requestId})`;
}

/**
 * Сделать один GET к каталоговому API и вернуть разобранное тело.
 *
 * Ответ `2xx` возвращается как JSON. Всё остальное бросает {@link ApiError} с
 * кодом и разобранным телом, потому что эти два вместе обычно и есть весь
 * диагноз.
 */
export async function apiGet<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const answer = await requestWithRetry(path, options);
  const body = parseBody(answer.text);

  if (!answer.ok) {
    // Идентификатор краулера — тот, под которым он записал запрос, — и его и
    // стоит называть; собственный идентификатор сайта остаётся запасным для
    // ответа без идентификатора.
    const requestId = answer.crawlerRequestId ?? answer.requestId;
    throw new ApiError(
      redact(failureMessage(answer.status, body, path, requestId), apiSecret()),
      {
        status: answer.status,
        body,
        path,
        requestId,
      },
    );
  }

  return body as T;
}

/**
 * Сырой текст GET — для единственного эндпоинта, который не JSON.
 *
 * Контракт отдаётся в YAML. Разбирать его здесь означало бы тащить в клиент
 * YAML-парсер ради одного теста.
 */
export async function apiGetText(path: string, options: ApiRequestOptions = {}): Promise<string> {
  // Контракт — это YAML, и краулер говорит об этом в своём `produces`. `*/*` в
  // конце оставляет помощник пригодным и для JSON-эндпоинтов, не заставляя
  // вызывающего угадывать, что он ожидает.
  const answer = await requestWithRetry(path, {
    accept: 'application/yaml, text/plain, */*',
    ...options,
  });

  if (!answer.ok) {
    const requestId = answer.crawlerRequestId ?? answer.requestId;
    throw new ApiError(
      redact(failureMessage(answer.status, parseBody(answer.text), path, requestId), apiSecret()),
      { status: answer.status, body: parseBody(answer.text), path, requestId },
    );
  }

  return answer.text;
}
