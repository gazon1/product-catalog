/**
 * Smoke-test деплоя: какой ответ валит выкат, а какой — только предупреждает.
 *
 * ## Что здесь под тестом
 *
 * Одно правило из issue #146: **отказ краулера не валит выкат, а неживой
 * процесс — валит.** Скрипт — это и есть политика, поэтому он исполняется
 * здесь против сервера, который отвечает так, как велит случай, а не сверяется
 * регулярным выражением по своему тексту.
 *
 * `curl` в скрипте настоящий: подменить его значило бы проверять не тот код,
 * который поедет на сервер. Поэтому сервер рукописный — он отвечает нужным
 * кодом и телом на каждый путь и закрывается после теста.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '..', 'scripts', 'smoke-test.sh');

/** Ответ сервера на путь: код и тело. */
type Answer = { status: number; body: string };

const open: ReturnType<typeof createServer>[] = [];

afterEach(() => {
  for (const server of open.splice(0)) server.close();
});

/** Поднять сервер, который отвечает на каждый путь своим ответом. */
async function serveFor(answers: Record<string, Answer>): Promise<string> {
  const server = createServer((req, res) => {
    const answer = answers[req.url ?? ''];
    if (!answer) {
      res.writeHead(500);
      res.end(`no answer for ${req.url}`);
      return;
    }
    res.writeHead(answer.status, { 'Content-Type': 'application/json' });
    res.end(answer.body);
  });
  open.push(server);

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

/** Запустить скрипт и вернуть код возврата и весь вывод. */
async function run(url: string): Promise<{ status: number; output: string }> {
  // Не `spawnSync`: он блокирует поток, в котором живёт подставной сервер, — и
  // скрипт, ждущий ответа, упирался бы в собственный таймаут.
  const child = spawn('bash', [SCRIPT], {
    env: { ...process.env, SMOKE_URL: url, SMOKE_ATTEMPTS: '2', SMOKE_DELAY: '0' },
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

const LIVE: Answer = { status: 200, body: '{"ok":true}' };
const DEAD: Answer = { status: 503, body: '{"ok":false}' };
const READY: Answer = { status: 200, body: '{"ok":true,"parser":"ready"}' };
const NOT_READY: Answer = { status: 503, body: '{"ok":false,"parser":"not-ready"}' };

describe('the deploy smoke test fails on liveness and warns on readiness', () => {
  it('passes when the process is alive and the catalog is ready', async () => {
    const url = await serveFor({ '/api/health': LIVE, '/api/ready': READY });
    const { status, output } = await run(url);

    expect(status).toBe(0);
    expect(output).toContain('Storefront process alive');
    expect(output).toContain('Catalog dependency ready');
    expect(output).not.toContain('::warning::');
  });

  it('fails when the process is not alive, whatever the catalog says', async () => {
    const url = await serveFor({ '/api/health': DEAD, '/api/ready': READY });
    const { status, output } = await run(url);

    expect(status).not.toBe(0);
    expect(output).toContain('::error::Storefront process did not become alive');
    // Readiness is never reached — the dead process is the whole finding.
    expect(output).not.toContain('Catalog dependency ready');
  });

  // The core of issue #146: this deployment must stay green.
  it('passes and warns when the process is alive but the parser is not ready', async () => {
    const url = await serveFor({ '/api/health': LIVE, '/api/ready': NOT_READY });
    const { status, output } = await run(url);

    expect(status).toBe(0);
    expect(output).toContain('Storefront process alive');
    expect(output).toContain(
      '::warning::The storefront is alive but the catalog dependency is not ready',
    );
    expect(output).toContain('not a storefront process failure');
  });

  it('refuses to run without SMOKE_URL', () => {
    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, SMOKE_URL: '' },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('SMOKE_URL must be set');
  });
});
