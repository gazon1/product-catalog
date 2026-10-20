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
 *   3. the crawler repository next to this one — the normal layout.
 *
 * The first candidate that exists wins, and the others are not consulted.
 *
 * The types of this module are declared in `contract-document.d.mts`, for the
 * TypeScript side — the tests and the site's own code — to import it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The root of this repository, whichever directory the module was loaded from. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
    resolve(ROOT, '..', 'wb-parser-kotlin-new', 'contract', 'catalog-v1.openapi.yaml'),
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
