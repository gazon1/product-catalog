import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const PIN_FILE = resolve(ROOT, 'contract', 'crawler-image.txt');
const SCRIPT = resolve(ROOT, 'scripts', 'update-image-pin.sh');

/**
 * The image pin, as the file names it.
 *
 * The pin is the storefront's statement about which crawler it understands, and
 * it is the one line of that file that is not a comment. A pin that names a
 * local tag is the arrangement for a checkout next to the crawler's; a pin that
 * names a digest is the release arrangement, and the two are told apart by the
 * shape of the reference.
 */
function pinnedImage(): string {
  const line = readFileSync(PIN_FILE, 'utf8')
    .split('\n')
    .map((row) => row.trim())
    .find((row) => row.length > 0 && !row.startsWith('#'));
  if (!line) throw new Error('contract/crawler-image.txt names no image');
  return line;
}

/**
 * The script, run against a throwaway copy of the repository.
 *
 * The script rewrites a tracked file and opens a pull request, so it is never
 * run against the real checkout here: the copy is what keeps the working tree
 * of a test run clean.
 */
function runScript(
  args: string[],
  options: { cwd?: string; root?: string } = {},
): { status: number; output: string } {
  try {
    const output = execFileSync('bash', [SCRIPT, ...args], {
      cwd: options.cwd ?? ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.root ? { ...process.env, PIN_ROOT: options.root } : process.env,
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

describe('the image pin', () => {
  it('names one image', () => {
    const image = pinnedImage();
    expect(image.length).toBeGreaterThan(0);
    // A reference is either a local tag or a registry digest — never a bare
    // word, and never two references at once.
    expect(image.split(/\s+/)).toHaveLength(1);
  });

  it('is either a local tag or a digest, and the two are never mixed', () => {
    const image = pinnedImage();
    const isDigest = image.includes('@sha256:');
    const isLocalTag = !image.includes('/') && !image.includes('@');
    expect(isDigest || isLocalTag).toBe(true);
  });

  it('names a digest when it names a registry image', () => {
    // A registry reference without a digest says "whatever the tag points at
    // when it is pulled" — and a tag can be moved. The pin must name one
    // image, so a registry pin is always a digest.
    const image = pinnedImage();
    if (!image.includes('/')) return;
    expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
});

describe('the pin moves only for a release build', () => {
  it('refuses a pull request image', () => {
    // The image of a pull request and the image of the merge that follows it
    // are two different images with two different digests — the merge rebuilds.
    // A pin that named the pull request's digest would name an image that is
    // never deployed.
    const digest = 'a'.repeat(64);
    const result = runScript(['--digest', `sha256:${digest}`, '--tag', 'pr-61', '--dry-run']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('pull request image');
  });

  it('refuses anything that is not a digest', () => {
    const result = runScript(['--digest', 'latest', '--dry-run']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('not a digest');
  });

  it('refuses a digest that is not one', () => {
    const result = runScript(['--digest', 'sha256:nothexadecimal', '--dry-run']);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('not a digest');
  });

  it('writes the digest it was given', () => {
    // The copy is what keeps the real checkout clean: the script rewrites a
    // tracked file, and a test that rewrote it would leave the tree dirty for
    // every later run.
    //
    // The copy holds the same shape as the repository — `contract/` and
    // `scripts/` beside each other — because the script finds its own root
    // from where it lives. A copy with a different shape would have the script
    // write into the real checkout.
    const digest = 'b'.repeat(64);
    const copy = resolve(ROOT, 'build', 'pin-test');
    execFileSync('bash', ['-c', `rm -rf "${copy}" && mkdir -p "${copy}"`]);
    execFileSync('bash', ['-c', `cp -r "${ROOT}/contract" "${ROOT}/scripts" "${copy}/"`]);

    const result = runScript(['--digest', `sha256:${digest}`, '--tag', 'abc1234', '--dry-run'], {
      cwd: copy,
      root: copy,
    });

    expect(result.status).toBe(0);
    const written = readFileSync(resolve(copy, 'contract', 'crawler-image.txt'), 'utf8');
    expect(written).toContain(`sha256:${digest}`);

    // And the real checkout is untouched.
    expect(pinnedImage()).not.toContain(digest);
  });
});
