#!/usr/bin/env node
/**
 * generate-contract-types.mjs — the storefront's types, generated from the crawler's contract.
 *
 * ## What this is for
 *
 * The crawler's OpenAPI document is the single source of truth for the shapes
 * the two sides exchange. This script turns it into `src/lib/api/types.generated.ts`:
 * the TypeScript types, and the runtime shadow of the schemas (the property
 * lists, with their types and their nullability) that the contract test
 * compares against the document.
 *
 * The generated file is committed. A generated file that is not committed
 * cannot be checked: `npm run contract-types:check` regenerates it and fails
 * when the result differs from what is committed. That check is what catches
 * "the contract changed and nobody regenerated the types" — a failure that
 * otherwise shows up much later, as an `undefined` on a page.
 *
 * ## The document is not copied into this repository
 *
 * The contract belongs to the crawler. This script reads it from wherever the
 * crawler keeps it — the same places the tests look, resolved by
 * `scripts/contract-document.mjs`, so the types and the test can never end up
 * describing two different documents.
 *
 * ## Determinism
 *
 * The same document always produces the same file, byte for byte: the types
 * come from the document's own text, the property lists follow the order the
 * document declares, and the document's fingerprint is a hash of its bytes.
 * A regeneration that produced a diff would make the staleness gate
 * meaningless, so the fingerprint of the document is written into the file as
 * well — a change to the document changes the file, even a change to a
 * comment.
 *
 * USAGE
 *   node scripts/generate-contract-types.mjs            # write the generated file
 *   node scripts/generate-contract-types.mjs --check    # fail if it is out of date
 *   node scripts/generate-contract-types.mjs --out FILE # write somewhere else
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import openapiTS, { astToString } from 'openapi-typescript';
import { loadContractDocument, resolveContractDocumentPath } from './contract-document.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'src', 'lib', 'api', 'types.generated.ts');

/**
 * The JSON types the contract uses.
 *
 * `integer` and `number` are distinct on purpose: a price in kopecks is a
 * whole number, a cashback percent is not, and a mirror that cannot tell
 * them apart cannot catch a field that changed from one to the other.
 */
const JSON_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object']);

/**
 * The schemas the site mirrors, and the name of the list each one becomes.
 *
 * The list is the runtime shadow of the schema: a TypeScript interface is
 * erased at runtime, so a test cannot compare it with the document. The
 * property list can be compared, field by field, and that comparison is what
 * makes a renamed or retyped field a failing test rather than a silently
 * `undefined` field on a page.
 */
const SCHEMA_LISTS = [
  ['ProductCard', 'PRODUCT_CARD_FIELDS'],
  ['PricePoint', 'PRICE_POINT_FIELDS'],
  ['TargetSummary', 'TARGET_SUMMARY_FIELDS'],
  ['PagedProductCard', 'PAGED_FIELDS'],
  ['SiteStats', 'SITE_STATS_FIELDS'],
  ['Error', 'ERROR_RESPONSE_FIELDS'],
];

/** The name of the schema a `$ref` points at. */
function referencedName(ref) {
  const prefix = '#/components/schemas/';
  if (!ref.startsWith(prefix)) {
    throw new Error(`the contract document refers to "${ref}", which this generator cannot resolve`);
  }
  return ref.slice(prefix.length);
}

/** The schema of the given name, or a clear error. */
function schemaOf(document, name) {
  const schema = document?.components?.schemas?.[name];
  if (!schema) {
    throw new Error(`the contract document declares no schema named "${name}"`);
  }
  return schema;
}

/** The declared types of one property, as a list. */
function declaredTypes(property, where) {
  const declared = property.type;
  if (declared === undefined) {
    if (property.$ref) return ['object'];
    throw new Error(`the contract document declares no type for ${where}`);
  }
  return Array.isArray(declared) ? declared : [declared];
}

/** The JSON type of one property, without the `null` the contract allows. */
function jsonTypeOf(property, where) {
  const types = declaredTypes(property, where);
  const base = types.find((type) => type !== 'null');
  if (base === undefined) {
    throw new Error(`the contract document declares only "null" for ${where}`);
  }
  if (!JSON_TYPES.has(base)) {
    throw new Error(
      `the contract document declares the type "${base}" for ${where}, which this generator ` +
        'does not know how to mirror',
    );
  }
  return base;
}

/** Whether the contract allows `null` for one property. */
function isNullable(property) {
  if (property.nullable === true) return true;
  return declaredTypes(property, 'a property').includes('null');
}

/** The properties of one schema, as the contract describes them. */
function propertiesOf(schema) {
  const properties = schema.properties ?? {};
  return Object.entries(properties).map(([name, property]) => ({
    name,
    type: jsonTypeOf(property, `the property "${name}"`),
    nullable: isNullable(property),
  }));
}

/**
 * The properties a composed schema adds to the one it extends.
 *
 * The contract declares the product detail as `allOf: [ProductCard, {...}]`:
 * the first part is the card it extends, the rest are the detail's own
 * properties. Those are read from the document, so a contract that grows a
 * field grows the mirror with it.
 *
 * A hand-written copy of them is exactly what goes stale: the contract gained
 * a field, the mirror did not, and the site went on validating answers
 * against a description of the contract that no longer held.
 */
function ownFieldsOf(document, name) {
  const schema = schemaOf(document, name);
  if (!schema.allOf) return [];

  const fields = [];
  for (const part of schema.allOf) {
    // The part that is a reference is the schema being extended — the card's
    // own properties, which the mirror already has.
    if (part.$ref) continue;
    fields.push(...propertiesOf(part));
  }
  return fields;
}

/**
 * The properties of one schema, with the parts of a composed schema merged.
 *
 * The contract declares the product detail as `allOf: [ProductCard, {...}]`,
 * so the detail's property set is the card's plus its own — the same list, not
 * a second hand-maintained copy of it.
 */
function fieldsOf(document, name) {
  const schema = schemaOf(document, name);
  if (!schema.allOf) return propertiesOf(schema);

  const fields = [];
  for (const part of schema.allOf) {
    const resolved = part.$ref ? schemaOf(document, referencedName(part.$ref)) : part;
    fields.push(...propertiesOf(resolved));
  }
  return fields;
}

/** One property, as the generated file writes it. */
function renderField(field) {
  return `  { name: '${field.name}', type: '${field.type}', nullable: ${field.nullable} },`;
}

/** The generated property list of one schema. */
function renderList(document, name, listName) {
  const fields = fieldsOf(document, name);
  const lines = fields.map(renderField);
  return [
    `/** The properties of \`${name}\`, as the contract describes them. */`,
    `export const ${listName} = [`,
    ...lines,
    `] as const;`,
  ].join('\n');
}

/**
 * The runtime shadow of the schemas: the property lists.
 *
 * The order is the contract's order, so a diff against the document reads as
 * a diff of the two and not of the two plus a reshuffle.
 */
function renderDescriptors(document) {
  const blocks = SCHEMA_LISTS.map(([name, listName]) => renderList(document, name, listName));

  // The detail is the card plus its own properties — the same list, extended,
  // so that the two cannot drift apart. The own properties come from the
  // document, so the mirror cannot fall behind the contract.
  const own = ownFieldsOf(document, 'ProductDetail');
  blocks.push(
    [
      "/** The properties of `ProductDetail`: the card\'s own, plus its own. */",
      'export const PRODUCT_DETAIL_FIELDS = [',
      '  ...PRODUCT_CARD_FIELDS,',
      ...own.map(renderField),
      '] as const;',
    ].join('\n'),
  );

  return blocks.join('\n\n');
}

/** The header of the generated file: what it is, and why it must not be edited. */
function renderHeader(fingerprint) {
  return `/**
 * types.generated.ts — GENERATED FILE. Do not edit it.
 *
 * ## What this file is
 *
 * The crawler's contract, in TypeScript. It is generated from the crawler's
 * own OpenAPI document (\`contract/catalog-v1.openapi.yaml\` in the crawler
 * repository) by \`npm run contract-types\`, and it is committed so that the
 * compiler has the shapes without everybody having to run the generator.
 *
 * ## Why it is committed
 *
 * A generated file that is not committed cannot be checked.
 * \`npm run contract-types:check\` regenerates it and fails when the result
 * differs from what is committed — that is the gate that catches "the
 * contract changed and nobody regenerated the types", which otherwise shows
 * up much later, as an \`undefined\` on a page.
 *
 * ## What is in here
 *
 *   - the types themselves, as \`openapi-typescript\` writes them;
 *   - the runtime shadow of the schemas: the property lists with their types
 *     and their nullability, which the contract test compares against the
 *     document, because an interface is erased at runtime and cannot be
 *     compared with anything.
 *
 * The site's own vocabulary — \`src/lib/api/types.ts\` — derives its
 * interfaces from the types above, so there is nothing here to keep in sync
 * by hand.
 *
 * ## The fingerprint
 *
 * The document's SHA-256 is part of the file. It is the hash of the
 * document's *bytes*, not of its meaning: a comment that changes the
 * contract's wording is still a change to the contract, and the gate has to
 * notice it. It is also what makes the generation deterministic — the same
 * document always produces this file, byte for byte.
 *
 * The document this file was generated from has the fingerprint
 * \`${fingerprint}\`.
 */`;
}

/** The whole generated file, as text. */
async function render() {
  const documentPath = resolveContractDocumentPath();
  const raw = loadContractDocument();
  const fingerprint = createHash('sha256').update(raw, 'utf8').digest('hex');
  const document = parse(raw);

  // The URL, not the path: the generator reads the document through a
  // resolver that resolves references against it.
  const types = astToString(await openapiTS(pathToFileURL(documentPath), { alphabetize: false }));

  return [
    renderHeader(fingerprint),
    types.trimEnd(),
    [
      '/* ---------------------------------------------------------------------------',
      ' * The runtime shadow of the schemas above.',
      ' *',
      ' * A TypeScript interface is erased at runtime, so a test cannot compare it',
      ' * with the contract document: `tsc` is happy with an interface that has',
      ' * drifted, and the drift only shows up where a field is read — at runtime,',
      ' * in production, on a page that renders an empty price. The property lists',
      ' * below are that shadow: one entry per property, with its type and its',
      ' * nullability, so the contract test can compare them with the document',
      ' * field for field.',
      ' * ------------------------------------------------------------------------- */',
      '',
      '/**',
      ' * The SHA-256 of the contract document this file was generated from.',
      ' *',
      ' * The hash is of the document\'s bytes, so that the staleness gate notices',
      ' * every change to it — a retyped field, a renamed property, and a comment',
      ' * that changes what the contract says.',
      ' */',
      `export const CONTRACT_DOCUMENT_SHA256 = '${fingerprint}';`,
      '',
      renderDescriptors(document),
    ].join('\n'),
    '',
  ].join('\n');
}

/** The first lines in which two texts differ, for a failure message. */
function firstDifference(current, expected) {
  const currentLines = current.split('\n');
  const expectedLines = expected.split('\n');
  const lines = [];

  for (let i = 0; i < Math.max(currentLines.length, expectedLines.length); i += 1) {
    if (currentLines[i] === expectedLines[i]) continue;
    lines.push(`  line ${i + 1}:`);
    lines.push(`    committed: ${currentLines[i] ?? '<end of file>'}`);
    lines.push(`    generated: ${expectedLines[i] ?? '<end of file>'}`);
    if (lines.length >= 12) break;
  }

  return lines.length > 0 ? lines.join('\n') : '  (the files differ only in their line endings)';
}

/** Write the generated file, or fail when it is out of date. */
async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const outIndex = args.indexOf('--out');
  const out = outIndex === -1 ? OUTPUT : resolve(ROOT, args[outIndex + 1]);

  const generated = await render();

  if (!check) {
    writeFileSync(out, generated, 'utf8');
    console.log(`contract types: written to ${out}`);
    return;
  }

  if (!existsSync(out)) {
    console.error(
      `contract types: ${out} does not exist. Run "npm run contract-types" to generate it.`,
    );
    process.exit(1);
  }

  const committed = readFileSync(out, 'utf8');
  if (committed === generated) {
    console.log(`contract types: ${out} is up to date`);
    return;
  }

  console.error('contract types: THE GENERATED FILE IS OUT OF DATE.');
  console.error('');
  console.error('The contract document and the committed types disagree. The types are what the');
  console.error('site compiles against, so a stale file means the site is talking to a contract it');
  console.error('no longer knows.');
  console.error('');
  console.error(firstDifference(committed, generated));
  console.error('');
  console.error('Fix it with: npm run contract-types');
  process.exit(1);
}

main().catch((err) => {
  console.error('contract types: generation failed', err);
  process.exit(1);
});
