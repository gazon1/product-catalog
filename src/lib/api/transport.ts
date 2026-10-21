/**
 * Транспорт: как именно витрина спрашивает каталог.
 *
 * ## Что здесь решается
 *
 * Один вопрос: **как спросить** — по какому адресу, с каким ключом, с каким
 * ожидаемым типом содержимого и в какие сроки. Транспорт ничего не знает ни о
 * том, какие параметры нужны (`params.ts`), ни о том, стоит ли спросить ещё раз
 * (`retry.ts`), ни о том, как читать ответ (`response.ts`).
 *
 * ## Два дедлайна
 *
 * `CONNECT_TIMEOUT_MS` ограничивает время до прихода *заголовков* ответа: три
 * секунды. Это бюджет на соединение — время, за которое нужно добраться до
 * краулера и получить начало ответа.
 *
 * `REQUEST_TIMEOUT_MS` ограничивает запрос целиком, вместе с телом: десять
 * секунд. Он заведомо **больше** собственного восьмисекундного таймаута
 * SQL-запроса краулера, чтобы запрос, упёршийся в этот таймаут, приходил
 * собственной ошибкой краулера — `5xx` с пояснением, — а не обрывался здесь и не
 * выглядел как сетевой сбой. Это разные инциденты: «каталог слишком медленный» и
 * «каталог недоступен» — не одно и то же, и оператор должен уметь их различать.
 *
 * Чтение каталога расширяет бюджет на соединение до общего: для запроса время
 * ответа *и есть* время запроса — заголовки приходят, когда SQL завершился, — и
 * трёхсекундный бюджет на соединение обрывал бы работу, на которую краулер
 * имеет право потратить восемь секунд.
 *
 * ## Идентификатор запроса
 *
 * Каждый вызов несёт собственный идентификатор, отправляет его в
 * `X-Request-Id`, и краулер отвечает тем же идентификатором в заголовке. Смысл —
 * корреляция: «каталог ответил 503» — это симптом, а «каталог ответил 503 на
 * запрос 7f3c…» — это симптом, который оператор найдёт в журнале краулера и
 * увидит, какой запрос упал, сколько он шёл и что краулер с ним сделал.
 */

import { ApiError, apiSecret, causeDetail, redact } from './error';

/** Префикс, под которым отдаётся контракт. */
export const API_PREFIX = '/api/catalog/v1';

/** Время, отведённое на приход заголовков ответа. */
export const CONNECT_TIMEOUT_MS = 3_000;

/** Время, отведённое на запрос целиком, вместе с телом ответа. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Параметры одного вызова. */
export interface ApiRequestOptions {
  /** Строка запроса. Полностью опускается, когда она пуста. */
  query?: URLSearchParams | undefined;
  /** Внешний сигнал отмены — для вызывающего, у которого есть свой дедлайн. */
  signal?: AbortSignal | undefined;
  /** Общий дедлайн. По умолчанию {@link REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Дедлайн на заголовки ответа. По умолчанию {@link CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /**
   * Тип содержимого, который хочет вызывающий. По умолчанию `application/json`.
   *
   * Его приходится называть вслух для единственного не-JSON эндпоинта: контракт
   * отдаётся в YAML, и клиент, попросивший JSON, получает `406` — честный ответ,
   * и вина клиента, что он спросил не то.
   */
  accept?: string | undefined;
}

/** Сырой ответ одного запроса — до того, как он разобран или оценён. */
export interface RawAnswer {
  ok: boolean;
  status: number;
  text: string;
  /** Идентификатор, который отправил сайт: когда ответа нет, это единственная ручка. */
  requestId: string;
  /** Идентификатор, которым ответил краулер, либо `null`, если ответа с ним не было. */
  crawlerRequestId: string | null;
  /** Названный ответом момент, как есть в заголовке, либо `null`. */
  retryAfter: string | null;
}

/**
 * Базовый адрес API — или ясная ошибка.
 *
 * Читается в момент вызова, а не в момент импорта: модуль, бросивший при
 * импорте, уронил бы всё приложение ещё на сборке, до того как кто-либо успел
 * задать переменную. Незаданная переменная — это ошибка развёртывания, и она
 * должна называть себя в тот момент, когда это уже важно.
 */
function apiRoot(): string {
  const raw = (process.env.CRAWLER_API_URL ?? '').trim();
  if (!raw) {
    throw new ApiError(
      'CRAWLER_API_URL is not set. The storefront reads the catalog through the ' +
        "crawler's HTTP API — set CRAWLER_API_URL to its base URL (see .env.example).",
    );
  }

  const withoutTrailingSlash = raw.replace(/\/+$/, '');

  // Контракт отдаётся под фиксированным префиксом. Принимая базовый адрес, который
  // уже несёт этот префикс, мы избавляемся от двойного префикса
  // (`/api/catalog/v1/api/catalog/v1`), который иначе получился бы при копировании
  // записи `servers` из документа OpenAPI.
  return withoutTrailingSlash.endsWith(API_PREFIX)
    ? withoutTrailingSlash
    : withoutTrailingSlash + API_PREFIX;
}

/** Ключ для связи с API — или ясная ошибка. */
function apiKey(): string {
  const key = apiSecret();
  if (!key) {
    throw new ApiError(
      'CRAWLER_API_KEY is not set. The catalog API requires a service-to-service ' +
        'key — set it to the crawler-side CATALOG_API_KEY (see .env.example).',
    );
  }
  return key;
}

/**
 * Идентификатор одного запроса.
 *
 * `crypto.randomUUID()` есть на глобальном объекте в Node 22 и в каждом браузере,
 * в котором этот сайт рендерится; он записан как `globalThis.crypto`, а не как
 * голый `crypto`, чтобы файл нельзя было принять за требующий импорта.
 */
function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Сделать один GET и вернуть сырой ответ.
 *
 * Здесь живут дедлайны и здесь каждый сбой становится {@link ApiError}. Разница
 * между двумя вызывающими — только в том, что они делают с телом, а дублировать
 * обработку таймаутов означало бы завести две слегка разные политики таймаутов.
 */
export async function request(
  path: string,
  options: ApiRequestOptions = {},
): Promise<RawAnswer> {
  // И то и другое читается здесь, в момент вызова, и оба бросают ясную ошибку,
  // когда их нет: развёртывание без базового адреса или без ключа — это ошибка
  // развёртывания, и она должна называть, какая именно.
  const secret = apiKey();
  const url = new URL(apiRoot() + path);
  if (options.query && options.query.toString() !== '') {
    url.search = options.query.toString();
  }

  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

  // Идентификатор уходит вместе с запросом, чтобы краулер мог записать тот, что
  // ему дали, даже если ответ не придёт вовсе.
  const requestId = newRequestId();

  const controller = new AbortController();
  let phase: 'connect' | 'overall' | null = null;

  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort);

  const overallTimer = setTimeout(() => {
    phase = 'overall';
    controller.abort();
  }, timeoutMs);

  // Бюджет на соединение: заголовков ещё нет, значит краулер либо недостижим,
  // либо не отвечает. Держится отдельно от общего таймера, чтобы два сбоя можно
  // было различить в журнале.
  const connectTimer = setTimeout(() => {
    phase = 'connect';
    controller.abort();
  }, connectTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Api-Key': secret,
        Accept: options.accept ?? 'application/json',
        'X-Request-Id': requestId,
      },
      signal: controller.signal,
    });

    // Заголовки пришли: соединение установлено, краулер ответил. Осталось тело,
    // а тело — это время запроса краулера, которое покрывает общий бюджет.
    clearTimeout(connectTimer);

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
      requestId,
      // Собственный идентификатор краулера, если он его прислал. Краулер, который
      // не шлёт заголовок, — не повод терять корреляцию: собственный
      // идентификатор сайта всё ещё здесь.
      crawlerRequestId: response.headers.get('X-Request-Id'),
      // Названный ответом момент, если он его назвал. Это собственное слово
      // сервера о том, когда его можно спросить снова.
      retryAfter: response.headers.get('Retry-After'),
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;

    if (phase === 'connect') {
      throw new ApiError(
        redact(
          `the catalog API did not answer within ${connectTimeoutMs} ms (the request timed out) for ${path} (request ${requestId})`,
          secret,
        ),
        { path, cause: err, requestId, timedOut: true },
      );
    }
    if (phase === 'overall') {
      throw new ApiError(
        redact(
          `the catalog API did not answer within ${timeoutMs} ms (the request timed out) for ${path} (request ${requestId})`,
          secret,
        ),
        { path, cause: err, requestId, timedOut: true },
      );
    }

    // Сетевой сбой: соединение отказали, хоста нет, не сошлось TLS-рукопожатие.
    // Собственный ответ краулера был бы лучше, но его нет — значит, ручка у нас
    // своя.
    const detail = causeDetail(err);
    throw new ApiError(
      redact(
        `the catalog API is unreachable for ${path}: ${detail} (request ${requestId})`,
        secret,
      ),
      {
        path,
        cause: err,
        requestId,
      },
    );
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(overallTimer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}
