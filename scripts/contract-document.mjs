/**
 * contract-document.mjs — where the crawler's contract document is, and how to read it.
 *
 * ## One resolution, two consumers
 *
 * The contract document lives in the crawler repository: it is *its* promise,
 * and the storefront keeps no copy of it. Two documents that describe the
 * same shapes are two sources of truth, and the one nobody reads is the one
 * that quietly licenses the next drift.
 *
 * Two things need that document. The tests validate the crawler's answers
 * against it, and the generator derives the storefront's types from it. They
 * must look at the *same* document — a test that checked the types against
 * one document while the generator built them from another would compare a
 * contract with itself and prove nothing. So the candidate list lives here,
 * once, and both sides ask this module where the document is.
 *
 * ## The candidates, in order
 *
 *   1. `CONTRACT_OPENAPI_PATH` — an explicit override, for a checkout that
 *      lives somewhere else;
 *   2. `contract/catalog-v1.openapi.yaml` inside this repository — where a
 *      pinned local copy would go;
 *   3. the crawler repository next to this one — the local layout;
 *   4. the crawler repository inside this one's directory — the CI layout.
 *
 * The first candidate that exists wins, and the others are not consulted.
 *
 * ## Why there are two layouts
 *
 * Locally the two repositories are two directories side by side. In CI the
 * crawler is checked out with `actions/checkout` and a `path:`, and that path
 * is resolved against the workspace, which *is* this repository's directory —
 * so the crawler lands inside it, not beside it. A resolver that knows only
 * one of the two layouts works locally and fails in CI, which is the worst
 * way for it to fail.
 *
 * The directory's name comes from `CRAWLER_DIR` when it is set, because that
 * is what the workflows call it.
 *
 * The types of this module are declared in `contract-document.d.mts`, for the
 * TypeScript side — the tests and the site's own code — to import it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The root of this repository, whichever directory the module was loaded from. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The directory the crawler is checked out into, when nothing says otherwise. */
const CRAWLER_DIR = process.env.CRAWLER_DIR || 'wb-parser-kotlin-new';

/**
 * Every place the contract document may be, most specific first.
 *
 * The order is the order of preference: an explicit override beats a local
 * pin, and a local pin beats whatever the sibling checkout happens to hold.
 *
 * @returns {string[]}
 */
export function contractDocumentCandidates() {
  return [
    process.env.CONTRACT_OPENAPI_PATH,
    resolve(ROOT, 'contract', 'catalog-v1.openapi.yaml'),
    resolve(ROOT, '..', CRAWLER_DIR, 'contract', 'catalog-v1.openapi.yaml'),
    resolve(ROOT, CRAWLER_DIR, 'contract', 'catalog-v1.openapi.yaml'),
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
}

/**
 * The path of the contract document, or a clear error.
 *
 * Failing loudly is the point: a caller that silently continued without a
 * document would generate types from nothing, or check them against nothing,
 * and report success either way.
 *
 * @returns {string}
 */
export function resolveContractDocumentPath() {
  for (const candidate of contractDocumentCandidates()) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    'the contract document was not found. Point CONTRACT_OPENAPI_PATH at the crawler’s ' +
      'contract/catalog-v1.openapi.yaml, or check the crawler out next to this repository.',
  );
}

/**
 * The contract document, read from disk.
 *
 * @returns {string}
 */
export function loadContractDocument() {
  return readFileSync(resolveContractDocumentPath(), 'utf8');
}
