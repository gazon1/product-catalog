import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const SCRIPT = resolve(ROOT, 'scripts', 'dependabot_bump.py');

/**
 * The bump in a Dependabot pull request.
 *
 * The auto-merge workflow merges a dependency update when the gates are
 * green — but only when the update cannot change the meaning of the code. A
 * patch fixes a bug in a library and a minor adds to it; a major moves APIs
 * under the code, and that is a change a person has to read.
 *
 * The bump cannot be read from the pull request's title when the updates are
 * grouped: the title names the group. It is read from the versions in the
 * description instead, which is where Dependabot writes what moved where.
 *
 * So the script is tested against the descriptions Dependabot actually
 * writes — including the ones where the answer must be "not mergeable".
 */
function classify(body: string): { bump: string; code: number } {
  try {
    const out = execFileSync('python3', [SCRIPT], { input: body, encoding: 'utf8' });
    return { bump: out.trim(), code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; status?: number };
    return { bump: (failure.stdout ?? '').trim(), code: failure.status ?? 1 };
  }
}

describe('the bump in a dependency update', () => {
  it('reads a patch', () => {
    const result = classify('Bumps foo from 1.2.3 to 1.2.4.');
    expect(result.bump).toBe('patch');
    expect(result.code).toBe(0);
  });

  it('reads a minor', () => {
    const result = classify('Bumps foo from 1.2.3 to 1.3.0.');
    expect(result.bump).toBe('minor');
    expect(result.code).toBe(0);
  });

  it('refuses a major', () => {
    const result = classify('Bumps foo from 1.2.3 to 2.0.0.');
    expect(result.bump).toBe('major');
    expect(result.code).not.toBe(0);
  });

  it('reads a grouped pull request by its strongest bump', () => {
    const body = [
      'Bumps the group across 1 directory with 3 updates.',
      '- [foo] updates from 1.0.0 to 1.0.1',
      '- [bar] updates from 2.0.0 to 2.1.0',
      '- [baz] updates from 3.0.0 to 3.0.1',
    ].join('\n');
    const result = classify(body);
    expect(result.bump).toBe('minor');
    expect(result.code).toBe(0);
  });

  it('refuses a group that carries a major', () => {
    const body = [
      'Bumps the group across 1 directory with 2 updates.',
      '- [foo] updates from 1.0.0 to 1.0.1',
      '- [bar] updates from 2.0.0 to 3.0.0',
    ].join('\n');
    const result = classify(body);
    expect(result.bump).toBe('major');
    expect(result.code).not.toBe(0);
  });

  it('refuses what it cannot read', () => {
    // A description without versions is not a patch. It is an unknown, and an
    // unknown is never merged by a machine.
    const result = classify('There is nothing to bump here.');
    expect(result.bump).toBe('unknown');
    expect(result.code).not.toBe(0);
  });
});
