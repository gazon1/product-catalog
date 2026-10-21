import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const SCRIPT = resolve(ROOT, 'scripts', 'dependency_decision.py');

/**
 * Решения по major-зависимостям, и инструмент, который их читает.
 *
 * Major — это решение, а не обновление: меняется поведение, ломаются
 * предположения, иногда нужна правка кода. Пока решение не записано, оно
 * каждый цикл висит как «человек решает», и список major'ов растёт молча.
 *
 * Ключ записи — зависимость, а не номер pull request'а: dependabot открывает
 * следующий pull request по той же зависимости, и решение, принятое однажды,
 * обязано находиться и для него.
 *
 * Этот файл доказывает, что инструмент ведёт себя так, как таблица обещает:
 * решение находится по зависимости, отсутствие решения так и называется, а
 * нечитаемая строка — это поломка, которая должна быть громкой.
 */
function fixture(table: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'dependency-decision-'));
  mkdirSync(resolve(dir, 'scripts'), { recursive: true });
  mkdirSync(resolve(dir, 'config'), { recursive: true });
  writeFileSync(resolve(dir, 'scripts', 'dependency_decision.py'), SCRIPT_SOURCE);
  writeFileSync(resolve(dir, 'config', 'dependency-decisions.tsv'), table);
  return dir;
}

const SCRIPT_SOURCE = execFileSync('cat', [SCRIPT], { encoding: 'utf8' });

function run(dir: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('python3', [resolve(dir, 'scripts', 'dependency_decision.py'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, DEPENDENCY_DECISIONS: resolve(dir, 'config', 'dependency-decisions.tsv') },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** Тело pull request'а dependabot'а об одной зависимости. */
const BODY = 'Bumps typescript from 5.6.3 to 7.0.0.\n';

describe('the decisions on the major dependencies', () => {
  it('are found by their dependency', () => {
    const dir = fixture('typescript\tdeferred\t5.6 → 7\tPR #35: `npm ci` не разрешается.\n');
    const result = run(dir, 'typescript');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deferred');
    expect(result.stdout).toContain('npm ci');
  });

  it('are found for the next pull request of the same dependency', () => {
    // Решение живёт под зависимостью, а не под номером: следующий pull
    // request по той же зависимости находит то же решение.
    const dir = fixture('typescript\tdeferred\t5.6 → 7\tPR #35: `npm ci` не разрешается.\n');
    const result = run(dir, 'typescript', '5.6.3', '7.0.0');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deferred');
    expect(result.stdout).toContain('PR #35');
  });

  it('say so when there is no decision', () => {
    const dir = fixture('typescript\tdeferred\t5.6 → 7\tпочему\n');
    const result = run(dir, 'vitest');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('none');
  });

  it('do not answer for another version', () => {
    // Решение, привязанное к бампу, не отвечает за другой бамп.
    const dir = fixture('typescript\tdeferred\t5.6 → 7\tпочему\n');
    const result = run(dir, 'typescript', '6.0.0', '7.0.0');
    expect(result.stdout.trim()).toBe('none');
  });

  it('do not mistake an empty table for a broken one', () => {
    const dir = fixture('# только комментарий\n\n');
    expect(run(dir, '--check').status).toBe(0);
  });

  it('do not mistake a missing table for a broken one', () => {
    const dir = fixture('# только комментарий\n\n');
    rmSync(resolve(dir, 'config', 'dependency-decisions.tsv'));
    expect(run(dir, '--check').status).toBe(0);
  });

  it('fail loudly when the table cannot be read', () => {
    const dir = fixture('typescript\tmerged\t5.6 → 7\tне то слово\n');
    const result = run(dir, '--check');
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('not a decision');
  });

  it('fail loudly when a row has no reason', () => {
    const dir = fixture('typescript\tdeferred\t5.6 → 7\n');
    const result = run(dir, '--check');
    expect(result.status).toBe(2);
  });

  it('find the dependency in the body of a pull request', () => {
    const dir = fixture('typescript\tdeferred\t5.6 → 7\tPR #35: `npm ci` не разрешается.\n');
    const body = resolve(dir, 'body.md');
    writeFileSync(body, BODY, 'utf8');
    const result = run(dir, '--pull-request', body);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deferred');
  });

  it('say that the dependency could not be read', () => {
    const dir = fixture('typescript\tdeferred\t5.6 → 7\tпочему\n');
    const body = resolve(dir, 'body.md');
    writeFileSync(body, 'ничего здесь нет\n', 'utf8');
    const result = run(dir, '--pull-request', body);
    expect(result.stdout.trim()).toBe('unknown');
  });

  it('are readable in the repository itself', () => {
    // Таблица в репозитории — часть контракта: сломанная таблица должна
    // падать громко, и это должен видеть гейт, а не человек.
    const result = run(ROOT, '--check');
    expect(result.status).toBe(0);
  });
});
