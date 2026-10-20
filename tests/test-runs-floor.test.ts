import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const SCRIPT = resolve(ROOT, 'scripts', 'check-test-runs.py');

/**
 * The floor, and the tool that maintains it.
 *
 * The floor says how many tests each file must have executed. It exists to
 * catch the case where a file stops running: `npm test` exits 0 whether it
 * ran 145 tests or one file fell out of the include list, so something has to
 * know what was expected.
 *
 * The tool that raises the floor is the dangerous one. It is run right after
 * a test run, and the obvious implementation — write the file from the
 * measurement — deletes every floor of every file that did not run in that
 * invocation. A single-file run would then erase the floors of the other
 * nine files, and the gate that was supposed to notice a file going quiet
 * would have been quietly disarmed.
 *
 * So the floor is merged into, never rewritten, and this file proves it: it
 * runs the tool against a fixture where only one file ran and checks that
 * the other floors are still there.
 */

/**
 * A copy of the repository's floor machinery, in a throwaway directory.
 *
 * The script finds its root from where it lives, so a copy of `scripts/` and
 * `config/` beside each other is a repository as far as it is concerned. The
 * real files are never touched.
 *
 * The floor in the copy is written by the test rather than copied from the
 * repository: the real floor moves every time a test is added, and a test
 * that asserted against it would break on every such commit — and would stop
 * meaning anything while it lasted.
 */
function fixture(): string {
  const dir = resolve(ROOT, 'build', 'floor-test');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, 'scripts'), { recursive: true });
  mkdirSync(resolve(dir, 'config'), { recursive: true });
  mkdirSync(resolve(dir, 'build', 'test-results'), { recursive: true });
  execFileSync('bash', ['-c', `cp "${SCRIPT}" "${dir}/scripts/"`]);
  writeFileSync(
    resolve(dir, 'config', 'test-runs-floor.tsv'),
    [
      'tests/image-pin.test.ts\t7',
      'tests/api-contract.test.ts\t32',
      'tests/slug.test.ts\t14',
      '',
    ].join('\n'),
    'utf8',
  );
  return dir;
}

/**
 * A JUnit report, hand-written, with one suite in it.
 *
 * The report is what the tool reads; the numbers in it are the numbers the
 * tool believes were executed. No reporter is run — the point is to control
 * exactly which file "ran", including the files that did not.
 */
function report(dir: string, files: { name: string; tests: number }[]): void {
  const suites = files
    .map(
      (file) =>
        `  <testsuite name="${file.name}" tests="${file.tests}">\n` +
        Array.from(
          { length: file.tests },
          (_, index) => `    <testcase name="case ${index}" />`,
        ).join('\n') +
        `\n  </testsuite>`,
    )
    .join('\n');
  writeFileSync(
    resolve(dir, 'build', 'test-results', 'vitest.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites}\n</testsuites>\n`,
    'utf8',
  );
}

function floorsOf(dir: string): Record<string, string> {
  const text = readFileSync(resolve(dir, 'config', 'test-runs-floor.tsv'), 'utf8');
  const floors: Record<string, string> = {};
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [name, count] = line.split('\t');
    if (name && count) floors[name] = count;
  }
  return floors;
}

describe('the floor is only ever raised', () => {
  it('keeps the floors of the files that did not run', () => {
    const dir = fixture();
    // One file ran. The other floors in the file must survive the update.
    report(dir, [{ name: 'tests/image-pin.test.ts', tests: 10 }]);

    execFileSync('python3', [resolve(dir, 'scripts', 'check-test-runs.py'), '--update'], {
      cwd: dir,
      encoding: 'utf8',
    });

    const floors = floorsOf(dir);
    expect(floors['tests/image-pin.test.ts']).toBe('10');
    // The file that did not run keeps the floor it had — this is the whole
    // point: a floor that is gone cannot catch a file that stopped running.
    expect(floors['tests/api-contract.test.ts']).toBe('32');
    expect(floors['tests/slug.test.ts']).toBe('14');
    // And the file that ran was raised, not left behind.
    expect(Object.keys(floors).sort()).toEqual([
      'tests/api-contract.test.ts',
      'tests/image-pin.test.ts',
      'tests/slug.test.ts',
    ]);
  });

  it('never lowers a floor on its own', () => {
    const dir = fixture();
    // The file ran fewer tests than its floor says. The floor is a decision
    // about deleted tests, and it is made by hand — not by a run.
    report(dir, [{ name: 'tests/image-pin.test.ts', tests: 1 }]);

    execFileSync('python3', [resolve(dir, 'scripts', 'check-test-runs.py'), '--update'], {
      cwd: dir,
      encoding: 'utf8',
    });

    expect(floorsOf(dir)['tests/image-pin.test.ts']).toBe('7');
  });
});
