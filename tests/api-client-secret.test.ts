/**
 * Ключ не должен попасть туда, где его читают люди.
 *
 * ## Что здесь под тестом
 *
 * Одно правило: **ключ не попадает в ответ витрины и в её журнал.** Он живёт в
 * заголовке `X-Api-Key` и больше нигде. Три пути, по которым он может
 * вернуться:
 *
 * 1. текст ошибки, который клиент кладёт в `ApiError` и который уходит в
 *    журнал — `ping()` пишет `err.message`;
 * 2. тело ответа краулера: краулер вправе процитировать присланный ключ в
 *    своём `error`, и этот текст попадает в сообщение витрины;
 * 3. то, что видит посетитель: страница показывает `describe(err)`, и она
 *    обязана остаться фразой для человека.
 *
 * ## Почему это отдельный набор, а не ещё пара тестов в транспортном
 *
 * Транспорт проверяет, куда ключ уходит: в URL, в заголовок, в тело запроса.
 * Здесь — обратное: откуда он может вернуться. Это другой вопрос, и он
 * закрывается другим кодом — тем, который обрезает сообщение и тем, который
 * превращает ошибку в страницу.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { apiGet, ApiError } from '@/lib/api/client';
import { redact } from '@/lib/api/error';
import { describe as describeFailure } from '@/lib/format';
import { ping } from '@/lib/catalog/requests';
import { API_KEY, useClientHarness } from './api-client-harness';

const harness = useClientHarness();

/** Ошибка, в которой ключ уже был, — как её получить по-настоящему. */
async function errorCarryingTheKey(): Promise<ApiError> {
  harness.answerWith(
    new Response(JSON.stringify({ error: `key ${API_KEY} is not accepted` }), { status: 401 }),
  );
  const error = await apiGet('/items').catch((err: unknown) => err);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('the key does not stay in the text of a failure', () => {
  it('redacts the key out of a message that already carries it', () => {
    const message = redact(`the proxy rejected ${API_KEY}`, API_KEY);
    expect(message).not.toContain(API_KEY);
    expect(message).toContain('[redacted]');
  });

  it('leaves a message alone when there is no key to hide', () => {
    expect(redact('the catalog did not answer', '')).toBe('the catalog did not answer');
  });

  it('does not let the key out of the message when the crawler quotes it back', async () => {
    const error = await errorCarryingTheKey();
    expect(error.message).not.toContain(API_KEY);
    expect(error.message).toContain('[redacted]');
  });

  // Тело ответа — тоже носитель ключа: краулер вправе процитировать его в
  // своём `error`. `ApiError.body` — публичное поле, и тот, кто ошибку
  // записывает в журнал целиком, унёс бы ключ с собой.
  it('does not let the key out of the body of the failure', async () => {
    const error = await errorCarryingTheKey();
    expect(JSON.stringify(error.body)).not.toContain(API_KEY);
    expect(JSON.stringify(error.body)).toContain('[redacted]');
  });

  it('keeps the key out of a body built by hand', () => {
    const error = new ApiError('the catalog said no', {
      body: { error: `key ${API_KEY} is not accepted`, nested: [`${API_KEY}`] },
    });
    expect(JSON.stringify(error.body)).not.toContain(API_KEY);
  });
});

describe('the key does not reach the visitor and does not reach the log', () => {
  it('shows the visitor a sentence, not the key', async () => {
    const error = await errorCarryingTheKey();
    const shown = describeFailure(error);
    expect(shown).not.toContain(API_KEY);
    expect(shown.length).toBeGreaterThan(0);
  });

  it('writes no key into the log when the catalog is not ready', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(' '));
    });

    harness.answerWith(
      new Response(JSON.stringify({ error: `key ${API_KEY} is not accepted` }), { status: 401 }),
    );
    expect(await ping()).toBe(false);

    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(API_KEY);
    }
  });

  // Страница не показывает сообщение ошибки: она показывает фразу
  // `describe()`. Показывает она `err.message` — ключ попадёт в HTML.
  it('renders no error message into a page', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(resolve(__dirname, '..', 'src', 'app'));
    walk(resolve(__dirname, '..', 'src', 'components'));

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const matches = source.match(/\b\w*(?:err|error)\w*\.message\b/g);
      if (matches) {
        offenders.push(`${file.replace(resolve(__dirname, '..') + '/', '')}: ${matches.join(', ')}`);
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
