/**
 * The HTTP client for the crawler's catalog API.
 *
 * ## What this file is
 *
 * A small, dependency-free wrapper around `fetch` that knows three things the
 * rest of the site should not have to: where the API is, how to authenticate
 * against it, and how long to wait for it. Everything else — which endpoint,
 * which parameters — belongs to `queries.ts`.
 *
 * ## The key
 *
 * The key is read from the environment and sent as `X-Api-Key`. It is never
 * logged, never put in an error message, and never put in a URL: a URL ends up
 * in access logs, in a proxy log, and in a crash report, and a key that lands
 * in any of those is a key that has to be rotated. `redact()` is the belt to
 * that braces — even an error that arrives with the key already in its text
 * cannot leak it.
 *
 * ## The two deadlines
 *
 * `CONNECT_TIMEOUT_MS` bounds the time until the response *headers* arrive:
 * three seconds. It is a connect budget — the time to reach the crawler and
 * get an answer started.
 *
 * `REQUEST_TIMEOUT_MS` bounds the whole request, body included: ten seconds.
 * It is deliberately **larger** than the crawler's own eight-second SQL
 * statement timeout, so a query that runs into the crawler's statement timeout
 * comes back as the crawler's own error — a `5xx` with a reason — instead of
 * being cut off here and reported as a network failure. The two failures mean
 * different things: "the catalog is too slow" and "the catalog is unreachable"
 * are not the same incident, and the operator needs to be able to tell them
 * apart.
 *
 * A catalog read widens the connect budget to the overall one, because for a
 * query the answer time *is* the query time: the headers arrive when the SQL
 * finishes, so a three-second connect budget would abort perfectly good work
 * that the crawler is allowed to take eight seconds over.
 *
 * ## The request id
 *
 * Every call carries an id of its own, sent as `X-Request-Id`, and the crawler
 * answers with the id it logged. The point is correlation: "the catalog API
 * answered 503" is a symptom, and "the catalog API answered 503 for request
 * 7f3c…" is a symptom an operator can look up in the crawler's log and see
 * which query failed, how long it ran and what it did about it.
 *
 * The id in a failure message is the **crawler's** id whenever the crawler
 * answered at all, because that is the id in the crawler's log. When there was
 * no answer — a refused connection, a timeout — there is no crawler's id, and
 * the site's own id is the only handle there is; it is the id the site sent,
 * and it is the id a proxy in between would have seen.
 */

/** The prefix the contract is served under. */
export const API_PREFIX = '/api/catalog/v1';

/** The time allowed for the response headers to arrive. */
export const CONNECT_TIMEOUT_MS = 3_000;

/** The time allowed for the whole request, body included. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A failed call to the catalog API.
 *
 * `status` is the HTTP status for an answer the API gave, and `0` for a
 * failure that happened before an answer existed — a refused connection, a
 * timeout, a DNS failure. A `401` is therefore distinguishable from a timeout
 * by the status alone, which is what the caller's error handling needs: a
 * `401` means the key is wrong (a deployment problem), a timeout means the
 * crawler is slow or down.
 */
export class ApiError extends Error {
  /** The HTTP status, or `0` when the request never produced an answer. */
  readonly status: number;

  /** The parsed response body, when there was one. */
  readonly body: unknown;

  /** The path that was requested. Never contains the key. */
  readonly path: string;

  /**
   * The id an operator can search the crawler's log for.
   *
   * The crawler's id when the crawler answered — that is the id it logged —
   * and the site's own id when it did not, because then the site's id is the
   * only handle the two sides share. `null` when the failure happened before
   * a request was ever made, such as a missing base URL.
   */
  readonly requestId: string | null;

  /**
   * Whether the failure was a deadline rather than an answer.
   *
   * The distinction decides whether the call is worth repeating: a request that ran
   * out of time says nothing about the request itself, so it may be asked again,
   * while a request that was answered and refused does not.
   */
  readonly timedOut: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      body?: unknown;
      path?: string;
      cause?: unknown;
      requestId?: string | null;
      timedOut?: boolean;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ApiError';
    this.status = options.status ?? 0;
    this.body = options.body;
    this.path = options.path ?? '';
    this.requestId = options.requestId ?? null;
    this.timedOut = options.timedOut ?? false;
  }
}

/** Options for one call. */
export interface ApiRequestOptions {
  /** The query string. Omitted entirely when empty. */
  query?: URLSearchParams | undefined;
  /** An external abort signal, for a caller that has its own deadline. */
  signal?: AbortSignal | undefined;
  /** The overall deadline. Defaults to {@link REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * The deadline for the response headers. Defaults to
   * {@link CONNECT_TIMEOUT_MS}.
   */
  connectTimeoutMs?: number;
  /**
   * The media type the caller wants. Defaults to `application/json`.
   *
   * It has to be said out loud for the one endpoint that is not JSON: the contract
   * document is served as YAML, and a client that asks for JSON is told `406` — which
   * is the honest answer, and the client's own fault for asking.
   */
  accept?: string | undefined;
}

/**
 * The base URL of the API, or a clear error.
 *
 * Read at call time, not at import time: a module that threw while being
 * imported would take the whole application down at build time, before anyone
 * had a chance to set the variable. A missing variable is a deployment
 * mistake, and it should say so at the moment the mistake matters.
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

  // The contract is served under a fixed prefix. Accepting a base URL that
  // already carries it avoids the double prefix
  // (`/api/catalog/v1/api/catalog/v1`) that copying the `servers` entry out of
  // the OpenAPI document would otherwise produce.
  return withoutTrailingSlash.endsWith(API_PREFIX)
    ? withoutTrailingSlash
    : withoutTrailingSlash + API_PREFIX;
}

/** The service-to-service key, or a clear error. */
function apiKey(): string {
  const key = (process.env.CRAWLER_API_KEY ?? '').trim();
  if (!key) {
    throw new ApiError(
      'CRAWLER_API_KEY is not set. The catalog API requires a service-to-service ' +
        'key — set it to the crawler-side CATALOG_API_KEY (see .env.example).',
    );
  }
  return key;
}

/**
 * Remove the key from a message.
 *
 * The key is never put into a message on purpose, so this should never change
 * anything. It is here because "should never" is not "cannot": an error thrown
 * by the runtime, or by a proxy, can carry text we did not write, and the one
 * string that must never leave this process is the key.
 */
function redact(message: string, secret: string): string {
  if (!secret) return message;
  return message.split(secret).join('[redacted]');
}

/** Parse a response body as JSON, falling back to the raw text. */
function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A body that is not JSON is still evidence: an HTML error page from a
    // proxy says something a bare status code does not.
    return text;
  }
}

/**
 * The id of one request.
 *
 * `crypto.randomUUID()` is on the global object in Node 22 and in every
 * browser this site is rendered in; it is spelled `globalThis.crypto` rather
 * than a bare `crypto` so that the file cannot be mistaken for one that needs
 * an import to work.
 */
function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The message for a non-2xx answer.
 *
 * The API's own `error` field is quoted when there is one: "the key does not
 * match" is a sentence an operator can act on, and a bare `401` is not.
 *
 * The request id is the last thing in the message because it is the handle
 * for everything else in it: the id is what turns "the catalog API answered
 * 503" into a question the crawler's log can answer.
 */
function failureMessage(status: number, body: unknown, path: string, requestId: string): string {
  const detail =
    body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? `: ${body.error}`
      : '';
  return `the catalog API answered ${status} for ${path}${detail} (request ${requestId})`;
}

/**
 * What the runtime said underneath the failure.
 *
 * `fetch` reports a refused connection as "fetch failed" and keeps the real
 * reason (`connect ECONNREFUSED 127.0.0.1:8099`) in the cause. The cause is
 * the part an operator needs, and the part the site's own error mapping
 * recognises — so it is carried into the message rather than dropped.
 */
function causeDetail(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return `${err.message} (${cause.message})`;
  return err.message;
}

/** The raw answer of one request, before it is parsed or judged. */
interface RawAnswer {
  ok: boolean;
  status: number;
  text: string;
  /** The id the site sent, which is the only handle there is when there is no answer. */
  requestId: string;
  /** The id the crawler answered with, or `null` when the answer carried none. */
  crawlerRequestId: string | null;
  /** The moment the answer named, as the raw header value, or `null`. */
  retryAfter: string | null;
}

/**
 * The number of times a request is attempted.
 *
 * Two means one retry: the first attempt and one more.
 *
 * ## Why there is a retry at all
 *
 * The two failures worth retrying are the two that are not about the request itself.
 *
 * A `503` is the crawler saying "the catalog cannot be served right now" — the database
 * is restarting, a statement hit the crawler's timeout, the readiness check says no. The
 * request was well-formed; the moment was not. Asking again a moment later is the
 * difference between a page that renders and a page that shows an error.
 *
 * A timeout is the same kind of failure seen from the other side: the crawler did not
 * answer in time, which is a statement about the crawler, not about the query.
 *
 * ## Why the retry is exactly one
 *
 * A retry is a request the caller did not ask for, and it costs the crawler's database a
 * query. One retry turns a single unlucky moment into a page that works; two retries turn
 * a crawler that is down into three times the load, which is the opposite of what the
 * retry is for.
 *
 * ## Why `4xx` is never retried
 *
 * A `4xx` is the crawler saying "this request is wrong" — a bad key, a parameter it
 * cannot interpret, a URL that does not exist. The second attempt would be wrong in
 * exactly the same way, and it would double the traffic of whoever is calling with a
 * broken key. A `429` is the same: the crawler asked the caller to wait, and the answer
 * is in the `Retry-After` header, not in asking again immediately. A `429` is an answer,
 * and the caller is entitled to see it.
 */
const MAX_ATTEMPTS = 2;

/**
 * The longest a named moment may make the caller wait.
 *
 * A server that names a moment is believed, but not without a bound: the
 * caller is a page render, and a page that hangs for a minute because a server
 * said so is worse than a page that shows an error. Ten seconds is one whole
 * request budget — a longer wait buys nothing the second attempt could not.
 */
export const RETRY_AFTER_MAX_MS = 10_000;

/**
 * The wait when the answer names no moment.
 *
 * A `503` without a `Retry-After` still means "not now", and asking again in
 * the same millisecond is asking again while the crawler is still saying no.
 */
export const RETRY_AFTER_DEFAULT_MS = 1_000;

/**
 * The backoff after a timeout.
 *
 * A timeout says the crawler is slow, not that it is gone: the statement it
 * was running may still be running. A second request in the same millisecond
 * adds pressure exactly when the service is already under it.
 */
export const TIMEOUT_RETRY_BACKOFF_MS = 250;

/**
 * The wait between two attempts.
 *
 * The seam exists so the wait can be proved without a test that really waits:
 * a suite that sleeps for two seconds a case is slow, and a case that measures
 * a real delay is a case that fails on a loaded machine. The default is the
 * real timer, and nothing in the running site replaces it.
 */
export const sleeper = {
  /** Wait for the given number of milliseconds. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};

/**
 * The delay to wait, with jitter.
 *
 * Full jitter: a random share of the computed wait, not the wait itself.
 * Callers refused at the same moment would otherwise retry in lockstep and
 * hit the crawler again as a wave — the same wave, a moment later.
 */
function jitter(delayMs: number): number {
  return Math.floor(Math.random() * delayMs);
}

/**
 * The moment the answer named, in milliseconds.
 *
 * The crawler sends the number of seconds until the caller may try again, so
 * the header is a delay and not a timestamp. Anything else — no header at all,
 * a date, a word — names no moment, and the caller falls back to the default
 * wait.
 */
function retryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const text = header.trim();
  if (text === '') return null;

  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  return Math.min(Math.floor(seconds * 1000), RETRY_AFTER_MAX_MS);
}

/**
 * Perform one GET and hand back the raw answer.
 *
 * This is where the deadlines live, and where every failure becomes an
 * {@link ApiError}. The two callers below differ only in what they do with a
 * body, and duplicating the timeout handling would be a way to have two
 * slightly different timeout policies.
 */
async function request(path: string, options: ApiRequestOptions = {}): Promise<RawAnswer> {
  // Both are read here, at call time, and both throw a clear error when they
  // are missing: a deployment without a base URL or without a key is a
  // deployment mistake, and it should say which one it is.
  const secret = apiKey();
  const url = new URL(apiRoot() + path);
  if (options.query && options.query.toString() !== '') {
    url.search = options.query.toString();
  }

  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

  // The id goes out with the request, so the crawler can log the one it was
  // given even when the answer never arrives.
  const requestId = newRequestId();

  const controller = new AbortController();
  let phase: 'connect' | 'overall' | null = null;

  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort);

  const overallTimer = setTimeout(() => {
    phase = 'overall';
    controller.abort();
  }, timeoutMs);

  // The connect budget: the headers have not arrived yet, so the crawler is
  // either not reachable or not answering. Kept apart from the overall timer
  // so the two failures can be told apart in the log.
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

    // The headers are here: the connection was established and the crawler
    // answered. What is left is the body, and the body is the crawler's query
    // time — which the overall budget covers.
    clearTimeout(connectTimer);

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
      requestId,
      // The crawler's own id, when it answered with one. A crawler that does
      // not send the header is not a reason to lose the correlation: the
      // site's own id is still there.
      crawlerRequestId: response.headers.get('X-Request-Id'),
      // The moment the answer named, when it named one. It is the server's
      // own word on when it may be asked again.
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

    // A network failure: the connection was refused, the host does not exist,
    // the TLS handshake failed. The crawler's own answer would have been
    // better, but there is none — so the site's own id is the handle.
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

/**
 * Perform one GET against the catalog API, and try once more if it is worth trying.
 *
 * ## What is worth repeating
 *
 * Two failures, and only two.
 *
 * A `503` is the crawler saying "the catalog cannot be served right now" — the
 * database is restarting, a statement hit the crawler's timeout, the readiness
 * check says no. The request was well-formed; the moment was not. Asking again
 * a moment later is the difference between a page that renders and a page that
 * shows an error.
 *
 * A timeout is the same kind of failure seen from the other side: the crawler did
 * not answer in time, which is a statement about the crawler, not about the
 * query.
 *
 * ## Why the second attempt waits
 *
 * Asking again in the same millisecond is asking again while the crawler is
 * still saying no. When the answer names the moment at which it may be asked
 * again — the `Retry-After` header — that moment is the wait: it is the
 * server's own word on how long its refusal lasts, and a client that ignores
 * it turns one refusal into two refusals in the same instant.
 *
 * The wait is jittered: the delay is a random share of the computed wait
 * rather than the wait itself, because callers refused at the same moment
 * would otherwise retry in lockstep and hit the crawler again as a wave.
 *
 * An answer that names no moment still gets a short wait rather than an
 * immediate second question, and a timeout gets a short backoff of its own: a
 * timeout means the crawler may still be working, and a second request in the
 * same millisecond adds pressure exactly when the service is already slow.
 *
 * The wait is capped. A caller must not hang for a minute because a server
 * said so.
 *
 * ## What is not
 *
 * A `4xx` is the crawler saying "this request is wrong" — a bad key, a parameter
 * it cannot interpret, a URL that does not exist. The second attempt would be
 * wrong in exactly the same way, and it would double the traffic of whoever is
 * calling with a broken key. A `429` is the same: the crawler asked the caller
 * to wait, and the answer is in the `Retry-After` header, not in asking again
 * immediately. A `429` is an answer, and the caller is entitled to see it —
 * which is also why a `429` is never retried here, however long its
 * `Retry-After` says to wait.
 *
 * A network failure — the connection refused, the host does not exist — is not
 * repeated either. The crawler is not there, and a second attempt would find it
 * still not there; the caller is better served by an honest error than by a
 * request that waits twice as long to fail the same way.
 *
 * ## Why the retry is exactly one
 *
 * A retry is a request the caller did not ask for, and it costs the crawler's
 * database a query. One retry turns a single unlucky moment into a page that
 * works; two retries turn a crawler that is down into three times the load,
 * which is the opposite of what the retry is for.
 */
async function requestWithRetry(
  path: string,
  options: ApiRequestOptions = {},
): Promise<RawAnswer> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const answer = await request(path, options);

      if (answer.status === 503 && attempt < MAX_ATTEMPTS) {
        // The crawler answered and said "not now". A moment later it may well say
        // "yes", and this is the one status where that is worth a second question.
        lastError = new ApiError(
          redact(failureMessage(503, parseBody(answer.text), path, answer.crawlerRequestId ?? answer.requestId), apiSecret()),
          {
            status: 503,
            body: parseBody(answer.text),
            path,
            requestId: answer.crawlerRequestId ?? answer.requestId,
          },
        );
        await sleeper.wait(jitter(retryAfterMs(answer.retryAfter) ?? RETRY_AFTER_DEFAULT_MS));
        continue;
      }

      return answer;
    } catch (err) {
      // A timeout is worth one more question; an answered refusal is not.
      if (err instanceof ApiError && err.timedOut && attempt < MAX_ATTEMPTS) {
        lastError = err;
        await sleeper.wait(jitter(TIMEOUT_RETRY_BACKOFF_MS));
        continue;
      }
      throw err;
    }
  }

  // The loop only falls through when the last attempt was a `503` — the answer
  // itself was thrown away, and the error built from it is what the caller sees.
  throw lastError;
}

/**
 * Perform one GET against the catalog API and return the parsed body.
 *
 * A 2xx answer is returned as JSON. Everything else throws an
 * {@link ApiError} carrying the status and the parsed body, because the two
 * together are usually the whole diagnosis: a `400` says which parameter was
 * wrong, a `401` says the key is wrong, a `503` says the catalog cannot be
 * served.
 */
export async function apiGet<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const answer = await requestWithRetry(path, options);
  const body = parseBody(answer.text);

  if (!answer.ok) {
    // The crawler's id is the one in its log, so it is the one worth naming;
    // the site's own id is the fallback for an answer that carried none.
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
 * The raw text of a GET, for the one endpoint that is not JSON.
 *
 * The contract document is served as YAML. Parsing it here would mean the
 * client carried a YAML parser for the sake of one test.
 */
export async function apiGetText(path: string, options: ApiRequestOptions = {}): Promise<string> {
  // The contract document is YAML, and the crawler says so in its `produces`. The
  // `*/*` at the end keeps the helper usable for the JSON endpoints too, without
  // making the caller say which one it expects.
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

/** The key as it is right now, for the redaction of a message about to be thrown. */
function apiSecret(): string {
  return (process.env.CRAWLER_API_KEY ?? '').trim();
}
