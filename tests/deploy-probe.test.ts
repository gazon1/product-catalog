/**
 * Проба изнутри контейнера: отказ валит выкат, тишина — нет.
 *
 * ## Что здесь под тестом
 *
 * Вторая половина политики issue #146: **отказ (401/403/404) — это настройка,
 * которую записал этот выкат, и она обязана валить; а краулер, который не
 * ответил, — чужая недоступность, и валить выкат она не должна.** Витрина уже
 * развёрнута и жива, а выкат, краснеющий от чужого простоя, учат просто
 * перезапускать до зелёного — и тогда зелёный перестаёт значить «получилось».
 *
 * ## Как исполняется, а не сверяется
 *
 * Скрипт исполняется целиком, с настоящим shell; подменён один `docker exec` —
 * на `node`, который запускает тот же код, что уехал бы в контейнер, и берёт
 * адрес из окружения. Поэтому проверяется то, что поедет на сервер, а не его
 * описание.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '..', 'scripts', 'probe-catalog-from-container.sh');

const open: ReturnType<typeof createServer>[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const server of open.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Ответ сервера: код. */
async function serveStatus(status: number): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end('{"ok":false}');
  });
  open.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

/** Адрес, на котором никто не слушает. */
const SILENT = 'http://127.0.0.1:1';

/**
 * Сервер, который принимает соединение и не отвечает — «чёрная дыра».
 *
 * Отказ соединения и молчание маршрута — разные сбои: первый приходит сразу,
 * второй не приходит никогда. Проба обязана быть ограничена по времени, иначе
 * шаг деплоя висит до таймаута job'а.
 */
async function serveBlackhole(): Promise<string> {
  const server = createServer(() => {
    // Deliberately never answers.
  });
  open.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

/**
 * Исполнить скрипт, подменив `docker exec <container> node -e <code>` на
 * локальный `node -e <code>`.
 *
 * Подмена ставится отдельным файлом в `PATH`, а не обёрткой вокруг `bash`: так
 * скрипт остаётся ровно тем файлом, который поедет на сервер.
 *
 * Не `spawnSync`: он блокирует поток, в котором живёт подставной сервер, — и
 * проба, ждущая ответа, упиралась бы в собственный таймаут.
 */
async function run(
  url: string,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number; output: string }> {
  const dir = mkdtempSync(resolve(tmpdir(), 'probe-catalog-'));
  dirs.push(dir);
  writeFileSync(
    resolve(dir, 'docker'),
    [
      '#!/usr/bin/env bash',
      '# docker exec <container> node -e <code>  ->  node -e <code>',
      'shift 3            # exec, the container name, node',
      'exec node "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const child = spawn('bash', [SCRIPT, 'product-catalog'], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      CRAWLER_API_URL: url,
      CRAWLER_API_KEY: 'test-key',
      ...extraEnv,
    },
  });

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const status = await new Promise<number>((done) => {
    child.on('close', (code) => done(code ?? 1));
  });
  return { status, output };
}

describe('the container-side catalog probe', () => {
  it('fails the deploy when the crawler refuses the request', async () => {
    const url = await serveStatus(401);
    const { status, output } = await run(url);

    expect(status).not.toBe(0);
    expect(output).toContain('it refused the request');
  });

  it('only warns when the crawler does not answer', async () => {
    const { status, output } = await run(SILENT);

    expect(status).toBe(0);
    expect(output).toContain('::warning::The storefront container cannot reach the catalog API right now');
    expect(output).not.toContain('it refused the request');
  });

  it('passes silently when the catalog answers', async () => {
    const url = await serveStatus(200);
    const { status, output } = await run(url);

    expect(status).toBe(0);
    expect(output).not.toContain('::warning::');
    expect(output).not.toContain('it refused');
  });

  // A 5xx is not a misconfiguration of this deploy: the crawler answered, and
  // it said it cannot serve right now.
  it('only warns when the crawler answers 5xx', async () => {
    const url = await serveStatus(503);
    const { status, output } = await run(url);

    expect(status).toBe(0);
    expect(output).toContain('::warning::The storefront container cannot reach the catalog API right now');
  });

  // A route that swallowed the request would otherwise hang the deploy step
  // until the job's own timeout — and read as a hung deployment, not an outage.
  it('only warns, and returns, when the route blackholes the request', async () => {
    const url = await serveBlackhole();
    const started = Date.now();
    const { status, output } = await run(url, { CRAWLER_PROBE_TIMEOUT_MS: '1500' });
    const elapsed = Date.now() - started;

    expect(status).toBe(0);
    expect(output).toContain('::warning::The storefront container cannot reach the catalog API right now');
    // Bounded by the probe's own deadline, not by the test's patience.
    expect(elapsed).toBeLessThan(15_000);
  });

  // A deadline this deploy cannot mean is this deploy's problem, not the
  // crawler's: it must not be reported as somebody else's outage.
  it.each(['0', 'abc', '2147483648'])(
    'refuses a meaningless deadline (%s) instead of warning about an outage',
    async (value) => {
      const url = await serveStatus(200);
      const { status, output } = await run(url, { CRAWLER_PROBE_TIMEOUT_MS: value });

      expect(status).not.toBe(0);
      expect(output).toContain('CRAWLER_PROBE_TIMEOUT_MS');
      expect(output).not.toContain('::warning::');
    },
  );
});
