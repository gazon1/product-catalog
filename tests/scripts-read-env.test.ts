/**
 * Тест на `scripts/read-env.sh`.
 *
 * ## Что здесь под тестом
 *
 * Одна функция — `read_env ИМЯ`. Ею читают адрес каталога и ключ `just dev`
 * и `stack-up.sh`, поэтому правило чтения проверяется один раз и в одном
 * месте: окружение важнее файла, одинарные кавычки — часть записи, а не
 * часть значения, `$` внутри значения остаётся `$`.
 *
 * ## Почему это стоит тестом
 *
 * Правило «снять кавычки» появилось из-за деплоя: значения пишутся в
 * `.env` в одинарных кавычках, чтобы compose прочитал их буквально. Если
 * `read_env` перестанет снимать кавычки, витрина получит адрес с кавычками
 * на конце и уйдёт в `401` — а увидим мы это только на VPS, где деплой уже
 * прошёл.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const READ_ENV = resolve(ROOT, 'scripts', 'read-env.sh');

/**
 * Читает переменную через `read_env` в отдельном bash-процессе.
 *
 * Отдельный процесс нужен, чтобы состояние окружения теста не влияло на
 * чтение: переменная может прийти и из окружения, и из файла, и эти два
 * источника не должны путаться между тестами.
 */
const readEnv = (
  name: string,
  options: { file?: string; env?: Record<string, string> } = {},
): string => {
  const script = `
    source "${READ_ENV}"
    read_env "${name}"
  `;
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    // `next/types/global` требует NODE_ENV в ProcessEnv; bash-процессу она
    // без нужды, но тип её требует.
    NODE_ENV: 'test',
    ...options.env,
    // Файл читается через переменную окружения: `read-env.sh` берёт путь из
    // `ENV_FILE` при подключении, и подменить его иначе нельзя.
    ...(options.file ? { ENV_FILE: options.file } : {}),
  };
  return execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: childEnv,
  });
};

describe('read_env reads a value the same way everywhere', () => {
  it('reads the value from the environment first', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'read-env-'));
    const envFile = resolve(dir, '.env');
    writeFileSync(envFile, "CRAWLER_API_URL='http://from-file:8080'\n");
    expect(
      readEnv('CRAWLER_API_URL', {
        file: envFile,
        env: { CRAWLER_API_URL: 'http://from-env:8080' },
      }),
    ).toBe('http://from-env:8080');
  });

  it('reads the value from the file when the environment is empty', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'read-env-'));
    const envFile = resolve(dir, '.env');
    writeFileSync(envFile, 'CRAWLER_API_URL=http://from-file:8080\n');
    expect(readEnv('CRAWLER_API_URL', { file: envFile })).toBe('http://from-file:8080');
  });

  // Кавычки — часть записи, а не часть значения: деплой пишет значения в
  // одинарных кавычках, и без их снятия адрес ушёл бы в сеть с кавычками.
  it('strips the single quotes the deploy writes', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'read-env-'));
    const envFile = resolve(dir, '.env');
    writeFileSync(envFile, "CRAWLER_API_KEY='secret'\n");
    expect(readEnv('CRAWLER_API_KEY', { file: envFile })).toBe('secret');
  });

  // `$` в значении остаётся `$`: иначе ключ, который деплой прислал как есть,
  // читался бы как развёрнутая переменная.
  it('keeps a dollar sign inside the value', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'read-env-'));
    const envFile = resolve(dir, '.env');
    writeFileSync(envFile, "CRAWLER_API_KEY='a$b'\n");
    expect(readEnv('CRAWLER_API_KEY', { file: envFile })).toBe('a$b');
  });

  // Значение может содержать `=` — например, base64 с padding'ом. Обрезать
  // его по первому `=` нельзя.
  it('keeps the whole value after the first equals sign', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'read-env-'));
    const envFile = resolve(dir, '.env');
    writeFileSync(envFile, 'CRAWLER_API_KEY=abc==\n');
    expect(readEnv('CRAWLER_API_KEY', { file: envFile })).toBe('abc==');
  });

  it('returns an empty string for an unknown variable', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'read-env-'));
    const envFile = resolve(dir, '.env');
    writeFileSync(envFile, 'CRAWLER_API_URL=http://from-file:8080\n');
    expect(readEnv('NOT_THERE', { file: envFile })).toBe('');
  });
});
