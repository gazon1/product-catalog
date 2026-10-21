import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
 * Этот файл доказывает, что инструмент ведёт себя так, как таблица обещает:
 * решение находится по номеру pull request'а, отсутствие решения так и
 * называется, а нечитаемая строка — это поломка, которая должна быть громкой.
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

describe('the decisions on the major dependencies', () => {
  it('are found by their pull request', () => {
    const dir = fixture('32\ttaken\ttestcontainers 10 → 12: гейты зелёные.\n');
    const result = run(dir, '32');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('taken');
    expect(result.stdout).toContain('testcontainers');
  });

  it('say so when there is no decision', () => {
    const dir = fixture('32\ttaken\tпочему\n');
    const result = run(dir, '35');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('none');
  });

  it('do not mistake an empty table for a broken one', () => {
    const dir = fixture('# только комментарий\n\n');
    expect(run(dir, '--check').status).toBe(0);
  });

  it('fail loudly when the table cannot be read', () => {
    const dir = fixture('32\tmerged\tне то слово\n');
    const result = run(dir, '--check');
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('not a decision');
  });

  it('fail loudly when a row has no reason', () => {
    const dir = fixture('32\ttaken\n');
    expect(run(dir, '--check').status).toBe(2);
  });

  it('are readable in the repository itself', () => {
    // Таблица в репозитории — часть контракта: сломанная таблица должна
    // падать громко, и это должен видеть гейт, а не человек.
    const result = run(ROOT, '--check');
    expect(result.status).toBe(0);
  });
});
