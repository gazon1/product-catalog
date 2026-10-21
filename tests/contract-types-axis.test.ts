/**
 * Ось гейта staleness'а: типы сверяются с контрактом **пина**, а не с `main`
 * краулера.
 *
 * ## Что здесь под тестом
 *
 * Витрина разговаривает не с `main` краулера, а с **пином** — тем образом,
 * который закреплён в `contract/crawler-image.txt`. Рядом с digest'ом пин
 * записывает коммит, из которого образ собран, а этот коммит говорит, какой
 * контракт образ знает. Типы витрины описывают именно этот контракт.
 *
 * Гейт, который сравнивает типы с контрактом `main` краулера, живёт на другой
 * оси: изменение контракта краулера роняет тогда **все** pull request'ы
 * витрины, включая пин-PR, который к контракту отношения не имеет, — и
 * разгребать это должен человек. Ниже — доказательство, что гейт идёт по пину,
 * и что PR, который двигает пин, привозит типы с собой.
 *
 * ## Почему всё проверяется на копиях
 *
 * Ни документ краулера, ни чужой репозиторий здесь не правятся: дрейф
 * доказывается на **копии** документа во временном каталоге, а скрипт пина
 * запускается на копии репозитория. Краулер владеет своим документом, и этот
 * репозиторий не имеет права его менять — даже чтобы доказать, что гейт
 * работает.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { pinnedCrawlerCommit } from '../scripts/contract-document.mjs';
import { loadContractDocument } from './global-setup';

/** Корень репозитория. */
const ROOT = resolve(__dirname, '..');

/** Генератор типов — так, как его запускает гейт. */
const GENERATOR = resolve(ROOT, 'scripts', 'generate-contract-types.mjs');

/** Скрипт, который двигает пин. */
const PIN_SCRIPT = resolve(ROOT, 'scripts', 'update-image-pin.sh');

/** Workflow гейта staleness'а. */
const TYPES_WORKFLOW = resolve(ROOT, '.github', 'workflows', 'contract-types.yml');

/** Workflow, который двигает пин. */
const PIN_WORKFLOW = resolve(ROOT, '.github', 'workflows', 'contract-compatibility.yml');

/** Временные каталоги, которые этот файл создал. */
const temporary: string[] = [];

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** Что один запуск сказал. */
interface Run {
  /** Код возврата: 0 — значит, всё сошлось. */
  status: number;
  /** Всё, что процесс написал, в любой поток. */
  output: string;
}

/**
 * Запустить процесс и рассказать, что он сказал.
 *
 * Процесс запускается, а не импортируется: гейт — это команда, и проверка,
 * которая существует только как функция, которую никто не запускает, гейтом не
 * является.
 */
function run(command: string, args: string[], env: Record<string, string> = {}): Run {
  try {
    const stdout = execFileSync(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

/**
 * Копия документа контракта с изменением в ней.
 *
 * Копия — это то, чем доказывается дрейф, не трогая краулера: генератор
 * указывают на копию через `CONTRACT_OPENAPI_PATH`, и у гейта спрашивают,
 * описывают ли закоммиченные типы её.
 */
function modifiedDocument(change: (text: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'product-catalog-contract-axis-'));
  temporary.push(dir);

  const path = join(dir, 'catalog-v1.openapi.yaml');
  writeFileSync(path, change(loadContractDocument()), 'utf8');
  return path;
}

/**
 * Копия репозитория, в которой можно двигать пин.
 *
 * Скрипт переписывает отслеживаемый файл и открывает pull request, поэтому
 * против настоящего checkout'а он не запускается никогда: копия — это то, что
 * оставляет дерево чистым.
 */
function repositoryCopy(name: string): string {
  const dir = resolve(ROOT, 'build', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, 'src', 'lib', 'api'), { recursive: true });
  cpSync(resolve(ROOT, 'contract'), resolve(dir, 'contract'), { recursive: true });
  cpSync(resolve(ROOT, 'scripts'), resolve(dir, 'scripts'), { recursive: true });
  cpSync(
    resolve(ROOT, 'src', 'lib', 'api', 'types.generated.ts'),
    resolve(dir, 'src', 'lib', 'api', 'types.generated.ts'),
  );
  return dir;
}

describe('гейт читает контракт, который называет пин', () => {
  it('берёт коммит из пина этой ветки', () => {
    // Пин — это заявление витрины о том, с каким краулером она говорит, а
    // коммит рядом с digest'ом говорит, какой контракт этот краулер знает.
    const commit = pinnedCrawlerCommit();
    expect(commit, 'the pin of this branch names no crawler commit').not.toBeNull();
    expect(commit).toMatch(/^[0-9a-f]{7,40}$/);

    // И коммит в файле — тот же самый, а не похожий.
    const written = readFileSync(resolve(ROOT, 'contract', 'crawler-image.txt'), 'utf8')
      .split('\n')
      .find((line) => line.trim().startsWith('# crawler-commit:'));
    expect(written).toContain(commit!);
  });

  it('берёт коммит из пина, а не из main краулера', () => {
    // Workflow гейта — это место, где решается, чей контракт читается. Если
    // он читает `main` краулера, то смена контракта краулера роняет все
    // pull request'ы витрины, и это должен разгребать человек.
    const workflow = readFileSync(TYPES_WORKFLOW, 'utf8');
    expect(workflow).toContain('steps.pin.outputs.commit');
    expect(workflow).not.toContain("vars.CRAWLER_REF || 'main'");
  });

  it('не выдумывает коммит, когда пин его не называет', () => {
    // Пин без коммита не говорит, какой контракт он утверждает. Догадка здесь
    // означала бы проверку чего-то другого, поэтому ответ — «нет», а не
    // «main краулера».
    const dir = mkdtempSync(join(tmpdir(), 'product-catalog-contract-axis-'));
    temporary.push(dir);
    const pinFile = join(dir, 'crawler-image.txt');
    writeFileSync(pinFile, 'ghcr.io/gazon1/wb-parser@sha256:' + 'a'.repeat(64) + '\n', 'utf8');

    expect(pinnedCrawlerCommit(pinFile)).toBeNull();
  });

  it('говорит, когда пин не называет коммита', () => {
    // Гейт, который проверил не то и сказал «всё хорошо», — это тот дефект,
    // против которого стоит весь этот репозиторий.
    const workflow = readFileSync(TYPES_WORKFLOW, 'utf8');
    expect(workflow).toContain('names no crawler commit');
    expect(workflow).toContain('exit 1');
  });
});

describe('смена контракта в main краулера не роняет витрину', () => {
  it('типы описывают контракт пина', () => {
    // Прямая проверка оси: с документом, который пин называет, гейт зелёный.
    const dir = mkdtempSync(join(tmpdir(), 'product-catalog-contract-axis-'));
    temporary.push(dir);
    const document = join(dir, 'catalog-v1.openapi.yaml');
    writeFileSync(document, loadContractDocument(), 'utf8');

    const result = run('node', [GENERATOR, '--check'], { CONTRACT_OPENAPI_PATH: document });
    expect(result.status, result.output).toBe(0);
  });

  it('а вот с изменившимся контрактом main — нет', () => {
    // Та же проверка на другой оси: контракт краулера изменился, и гейт,
    // который смотрит на `main` краулера, был бы красным. Именно поэтому
    // гейт смотрит на пин: пока пин не сдвинулся, витрина не знает про
    // изменение и не должна об этом знать.
    const copy = modifiedDocument((text) => text.replace('inStock:', 'inStockFlag:'));

    const result = run('node', [GENERATOR, '--check'], { CONTRACT_OPENAPI_PATH: copy });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('OUT OF DATE');
  });
});

describe('pull request, который двигает пин, привозит типы', () => {
  it('перегенерирует типы по контракту закрепляемого коммита', () => {
    // Пин говорит «этот краулер», типы говорят «вот какой у него контракт».
    // Одно без другого — витрина, которая наполовину адаптировалась.
    const copy = repositoryCopy('contract-axis-pin');
    const document = modifiedDocument((text) => text.replace('inStock:', 'inStockFlag:'));
    const digest = 'd'.repeat(64);

    const result = run(
      'bash',
      [
        PIN_SCRIPT,
        '--digest',
        `sha256:${digest}`,
        '--tag',
        'abc1234',
        '--crawler-commit',
        '4d4eea28d4216f32d3c095ef048524dc93cabd31',
        '--contract-document',
        document,
        '--dry-run',
      ],
      { PIN_ROOT: copy },
    );
    expect(result.status, result.output).toBe(0);

    // Пин называет новый образ и коммит, из которого он собран.
    const pin = readFileSync(resolve(copy, 'contract', 'crawler-image.txt'), 'utf8');
    expect(pin).toContain(`sha256:${digest}`);
    expect(pin).toContain('# crawler-commit: 4d4eea28d4216f32d3c095ef048524dc93cabd31');

    // А типы — те, что описывают контракт этого коммита.
    const types = readFileSync(resolve(copy, 'src', 'lib', 'api', 'types.generated.ts'), 'utf8');
    expect(types).toContain('inStockFlag');
    const fingerprint = createHash('sha256')
      .update(readFileSync(document, 'utf8'), 'utf8')
      .digest('hex');
    expect(types).toContain(`CONTRACT_DOCUMENT_SHA256 = '${fingerprint}'`);
  });

  it('и гейт для этого пина зелёный', () => {
    // Тот же гейт, что и в CI, — но против документа закрепляемого коммита и
    // против типов, которые приедут тем же pull request'ом.
    const copy = repositoryCopy('contract-axis-pin-green');
    const document = modifiedDocument((text) => text.replace('inStock:', 'inStockFlag:'));

    const moved = run(
      'bash',
      [
        PIN_SCRIPT,
        '--digest',
        `sha256:${'e'.repeat(64)}`,
        '--tag',
        'abc1234',
        '--crawler-commit',
        '4d4eea28d4216f32d3c095ef048524dc93cabd31',
        '--contract-document',
        document,
        '--dry-run',
      ],
      { PIN_ROOT: copy },
    );
    expect(moved.status, moved.output).toBe(0);

    const checked = run('node', [resolve(copy, 'scripts', 'generate-contract-types.mjs'), '--check'], {
      CONTRACT_OPENAPI_PATH: document,
    });
    expect(checked.status, checked.output).toBe(0);
  });

  it('джоб пина отдаёт скрипту и контракт, и коммит', () => {
    // Workflow — это то, что на самом деле двигает пин. Скрипт, который умеет
    // больше, чем вызывают, — это возможность, которой никто не пользуется.
    const workflow = readFileSync(PIN_WORKFLOW, 'utf8');
    expect(workflow).toContain('--contract-document');
    expect(workflow).toContain('--crawler-commit');
  });
});

describe('несовместимые типы называют, что именно не компилируется', () => {
  it('гейт говорит, что типы не компилируются против кода витрины', () => {
    // Красный `typecheck` в пин-PR — это и есть тот случай, когда контракт
    // изменился так, что витрине нужен человек. Сообщение обязано называть
    // предмет: не «что-то сломалось», а «эти типы не компилируются», и
    // компилятор говорит, где именно.
    const workflow = readFileSync(TYPES_WORKFLOW, 'utf8');
    expect(workflow).toContain('npm run typecheck');
    expect(workflow).toContain('do not compile');
    expect(workflow).toContain('names the file and the line');
  });
});
