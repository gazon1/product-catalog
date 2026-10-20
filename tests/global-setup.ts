/**
 * Vitest global setup — the crawler's own container for the whole suite.
 *
 * ## What changed, and why it matters more than it looks
 *
 * The suite used to start a PostgreSQL container, apply the crawler's
 * migrations from a *copy* kept in `dev/db/`, apply a seed from a second copy,
 * and then let the storefront query that database with its own SQL. The copy
 * was the weak point: a crawler migration that renamed a column left both
 * repositories green and produced an empty storefront in production. The
 * storefront was testing its SQL against a schema it had forked.
 *
 * Now the crawler runs as a container, applies its own migrations and seeds
 * itself, and the storefront talks to it over HTTP through its public
 * functions. There is no copy of the schema in this repository any more, and
 * no SQL — the storefront cannot drift from the schema because it never sees
 * the schema.
 *
 * ## Docker missing is a failure, not a skip
 *
 * If the Docker daemon cannot be reached, this throws. A suite that reports
 * success without executing is worse than no suite: it is a green build that
 * verified nothing, which is the exact defect the rest of this repository
 * works against.
 *
 * ## A missing crawler image is the contract test's failure, not everybody's
 *
 * The crawler image is a separate artifact, built by another repository. When
 * it is not there, the *contract test* fails with a message that says exactly
 * which image is missing and how to provide it — and the rest of the suite
 * still runs. That is not a skip: the file fails, loudly, and the exit code
 * says so. The unit tests, the architecture gate and the type check do not
 * need a crawler, and hiding them behind a missing artifact would make it
 * harder to tell "the contract does not hold" from "the environment is not
 * ready".
 *
 * ## The values are handed over in a file
 *
 * The base URL and the key go to the workers through a file rather than an
 * environment variable: vitest's `globalSetup` runs in the main process while
 * the tests run in worker processes, and an env var set in the former is not
 * guaranteed to reach the latter. A file both can read.
 *
 * The file is written outside the repository. The obvious place —
 * `node_modules/.vitest-...` — puts a file that changes on every run inside a
 * tree vitest watches, which is a reliable way to end up with open file
 * handles at exit. The temp directory is not watched, and it is removed in
 * teardown either way.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Network, type StartedNetwork, type StartedTestContainer } from 'testcontainers';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { loadContractDocument as readContractDocument } from '../scripts/contract-document.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/** The port the crawler serves the catalog API on. */
const CRAWLER_PORT = 8080;

/** The key the crawler is started with, and the storefront reads with. */
const API_KEY = 'contract-test-key';

/**
 * The admin API's key.
 *
 * A different secret from the catalog's, on purpose: the crawler refuses to start
 * without it, and the catalog does not accept it. A test that used one value for
 * both would not notice the difference — and the difference is the whole point of
 * having two.
 */
const ADMIN_API_KEY = 'contract-test-admin-key';

/** The role the demo seed connects as. */
const DEMO_SEED_ROLE = 'wb_demo_seed';

/** The password of the demo seed's role. */
const DEMO_SEED_PASSWORD = 'contract-demo-seed-password';

/** The password of the catalog's read-only role. */
const CATALOG_ROLE_PASSWORD = 'contract-catalog-role-password';

/** How long the crawler gets to apply its migrations, seed itself and answer. */
const READY_TIMEOUT_MS = 120_000;

/**
 * The file the values are handed over in.
 *
 * The directory is created when the setup runs, not when the module is loaded:
 * a test file may import this module for its helpers, and a worker that
 * created a temp directory of its own would leave it behind.
 */
let connectionDir: string | null = null;
let connectionFile: string | null = null;

declare global {
  // eslint-disable-next-line no-var
  var __catalogCrawlerStarted: StartedTestContainer | undefined;
  // eslint-disable-next-line no-var
  var __catalogPostgresStarted: StartedTestContainer | undefined;
  // eslint-disable-next-line no-var
  var __catalogNetworkStarted: StartedNetwork | undefined;
}

/** What the workers are told about the running crawler. */
export interface ContractEnvironment {
  /** The base URL of the catalog API, prefix included. */
  apiUrl: string | null;
  /** The key to send as `X-Api-Key`. */
  apiKey: string | null;
  /** The image reference the run was pinned to. */
  image: string | null;
  /** The image id that reference resolves to. */
  imageId: string | null;
  /** The id of the container that was actually started. */
  containerId: string | null;
  /** The connection string of the crawler's own PostgreSQL, for the record. */
  postgresUri: string | null;
  /** Why the crawler is not there, when it is not there. */
  error: string | null;
}

/**
 * The image the run is pinned to.
 *
 * `CONTRACT_CRAWLER_IMAGE` wins, so a reviewer can point the suite at a
 * freshly built image without editing a file; otherwise the pin in
 * `contract/crawler-image.txt` is used. The pin is a *reference*, and the
 * contract test checks that the container really ran that reference's image —
 * a test that silently ran against some other local tag proves nothing.
 */
export function resolveCrawlerImage(): string {
  const fromEnv = (process.env.CONTRACT_CRAWLER_IMAGE ?? '').trim();
  if (fromEnv) return fromEnv;

  const fromFile = readFileSync(resolve(ROOT, 'contract', 'crawler-image.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));

  if (!fromFile) {
    throw new Error(
      'contract/crawler-image.txt names no image. Put the crawler image reference there, ' +
        'or set CONTRACT_CRAWLER_IMAGE.',
    );
  }
  return fromFile;
}

/**
 * The crawler's contract document, read from disk.
 *
 * The storefront keeps no copy of it on purpose: two documents that describe
 * the same shapes are two sources of truth, and the one nobody reads is the
 * one that quietly licenses the next drift. The crawler's own document is
 * authoritative, and it is read from the crawler's checkout — or from wherever
 * `CONTRACT_OPENAPI_PATH` points.
 *
 * The running crawler serves the same document at `GET /api/catalog/v1/contract`,
 * and the contract test validates the live answers against *that* copy. This
 * function is for the tests that need the document without a crawler.
 *
 * Where the document is resolved lives in `scripts/contract-document.mjs`, and
 * not here: the generator that writes the site's types has to read the very
 * same document, and two resolutions that could disagree would let the types
 * and the test describe two different contracts.
 */
export function loadContractDocument(): string {
  return readContractDocument();
}

/** The contract document, parsed. */
export function parseContractDocument(): unknown {
  return parse(loadContractDocument());
}

/** Rewrite the document's component references onto a local `$defs` block. */
function withLocalRefs(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.startsWith('#/components/schemas/')
      ? `#/$defs/${value.slice('#/components/schemas/'.length)}`
      : value;
  }
  if (Array.isArray(value)) return value.map(withLocalRefs);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = withLocalRefs(item);
    }
    return out;
  }
  return value;
}

/**
 * A validator for one component schema of a contract document.
 *
 * The document is an OpenAPI 3.1 file, which is JSON Schema 2020-12 with a
 * few extra sections around it. Only the `components.schemas` part is a schema
 * that answers questions about a body, so that is what is compiled — with the
 * component references rewritten onto a local `$defs` block, because the
 * validator has no document to resolve `#/components/...` against.
 */
export function buildValidator(document: unknown, name: string) {
  const schemas = (document as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {};
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile({
    $defs: withLocalRefs(schemas) as Record<string, unknown>,
    $ref: `#/$defs/${name}`,
  });
}


/** The id the image reference resolves to, or null when there is no such image. */
function imageIdOf(reference: string): string | null {
  try {
    return execFileSync('docker', ['image', 'inspect', reference, '--format', '{{.Id}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Pull the image when the pin names a digest and it is not on this machine.
 *
 * A pin that names a digest names an image in the registry, and a registry
 * image is not on anybody's machine until it is pulled. Without this the suite
 * would fail with "the image is not available locally" for a pin that is
 * perfectly valid — and the failure would look like a broken pin rather than
 * a missing download.
 *
 * A pin that names a local tag is not pulled: there is nothing to pull it
 * from, and the tag is built by the developer's own `just app::docker-build`.
 */
function ensureImageIsPresent(reference: string): void {
  if (!reference.includes('@sha256:')) return;
  if (imageIdOf(reference) !== null) return;

  console.log(`\n  pulling ${reference}…\n`);
  try {
    execFileSync('docker', ['pull', reference], {
      encoding: 'utf8',
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch {
    // The failure is reported by the caller, which knows what the missing
    // image means for the suite. This function only makes the attempt.
  }
}

/**
 * The Docker daemon has to be there.
 *
 * Without it the contract test cannot run, and a suite that quietly continues
 * without it reports success while verifying nothing.
 */
function assertDockerIsAvailable(): void {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error(
      'Docker is not available, so the catalog contract cannot be tested. ' +
        'This is a failure and not a skip: a suite that reports success without ' +
        'executing is worse than no suite at all.',
    );
  }
}

/**
 * Wait until the crawler answers its own readiness probe.
 *
 * The probe is the crawler's own statement that the catalog can be served:
 * its pool can execute a statement and the columns the catalog reads are
 * present. Waiting for it means the contract test starts against a crawler
 * that has already applied its migrations and seeded itself.
 */
async function waitForReady(apiUrl: string): Promise<string | null> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastProblem = 'the crawler did not answer';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/ready`, {
        headers: { 'X-Api-Key': API_KEY },
        signal: AbortSignal.timeout(3_000),
      });

      if (response.ok) return null;

      if (response.status === 401) {
        return 'the crawler rejected the test key (401). The crawler and the storefront must be ' +
          'started with the same key.';
      }
      if (response.status === 404) {
        return 'the image does not serve /api/catalog/v1/ready — the catalog API is not ' +
          'implemented in this image. Build an image that contains it.';
      }
      lastProblem = `the readiness probe answered ${response.status}`;
    } catch (err) {
      lastProblem = err instanceof Error ? err.message : 'unknown error';
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }

  return `the crawler did not become ready within ${READY_TIMEOUT_MS / 1000} s: ${lastProblem}`;
}

/** Create the hand-over directory and write the values into it. */
function writeHandoff(values: ContractEnvironment): void {
  connectionDir = mkdtempSync(join(tmpdir(), 'product-catalog-contract-'));
  connectionFile = join(connectionDir, 'contract.json');
  writeFileSync(connectionFile, JSON.stringify(values), 'utf8');
}

export default async function setup(): Promise<void> {
  assertDockerIsAvailable();

  const image = resolveCrawlerImage();
  ensureImageIsPresent(image);
  const imageId = imageIdOf(image);

  if (imageId === null) {
    // The image is a separate artifact from another repository. Its absence is
    // the contract test's failure, with a message that says what to do about
    // it — and the rest of the suite still runs.
    writeHandoff({
      apiUrl: null,
      apiKey: null,
      image,
      imageId: null,
      containerId: null,
      postgresUri: null,
      error:
        `the crawler image "${image}" is not available locally. Pull it (docker pull ` +
        `"${image}"), build it in the crawler repository (just app::docker-build), or ` +
        `point the suite at another one: CONTRACT_CRAWLER_IMAGE=<image> npm test`,
    });
    console.log(`\n  ⚠ the crawler image "${image}" is not available — the contract test will fail\n`);
    return;
  }

  // The crawler reaches the database over this network, by the alias below.
  // The storefront never sees the connection string: the database is the
  // crawler's, and the crawler's credentials are the crawler's business.
  try {
    const network = await new Network().start();
    globalThis.__catalogNetworkStarted = network;

    const postgres = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('product_catalog_contract')
      .withUsername('catalog')
      .withPassword('catalog')
      .withNetwork(network)
      .withNetworkAliases('postgres')
      .start();
    globalThis.__catalogPostgresStarted = postgres;

    // The crawler reads the database over the network, by the alias above.
    const crawler = await new GenericContainer(image)
      .withNetwork(network)
      .withNetworkAliases('crawler')
      .withExposedPorts(CRAWLER_PORT)
      .withEnvironment({
        DB_HOST: 'postgres',
        DB_PORT: '5432',
        DB_NAME: 'product_catalog_contract',
        DB_USER: 'catalog',
        DB_PASSWORD: 'catalog',
        // The crawler migrates and seeds itself. The storefront applies no SQL
        // of its own any more — that is the entire point of this change.
        SPRING_FLYWAY_ENABLED: 'true',
        // The admin API's key. The crawler refuses to start without it, in every
        // profile but `once` — it is a separate secret from the catalog's, and
        // the catalog does not accept it.
        ADMIN_API_KEY: ADMIN_API_KEY,
        // The demo profile and the demo seed.
        //
        // The seed is what fills the database: the crawler carries its own
        // synthetic data, next to the schema it targets, and it is the thing
        // that proves the catalog's role exists and can read. The seed is
        // guarded by five barriers — the flag, the profile, the exact role the
        // seeding connection resolves to, the marker the database carries, and
        // the emptiness of the tables — and a test database that is fresh and
        // empty satisfies all five.
        SPRING_PROFILES_ACTIVE: 'demo',
        CATALOG_DEMO_SEED_ENABLED: 'true',
        CATALOG_DEMO_DB_USER: DEMO_SEED_ROLE,
        CATALOG_DEMO_DB_PASSWORD: DEMO_SEED_PASSWORD,
        CATALOG_DEMO_EXPECTED_ROLE: DEMO_SEED_ROLE,
        CATALOG_DEMO_DB_ID: 'product-catalog-contract',
        // The catalog's own pool: the same database, a different role. The
        // crawler provisions that role itself as part of the demo bootstrap.
        CATALOG_DB_USER: 'wb_catalog_ro',
        CATALOG_DB_PASSWORD: CATALOG_ROLE_PASSWORD,
        // No crawling during a test: the suite is about the catalog API, and a
        // crawler walking Wildberries would make the data move under the
        // assertions.
        CRAWLER_WORKER_ENABLED: 'false',
        CATALOG_API_KEY: API_KEY,
        ...extraCrawlerEnvironment(),
      })
      .start();
    globalThis.__catalogCrawlerStarted = crawler;

    const apiUrl = `http://${crawler.getHost()}:${crawler.getMappedPort(CRAWLER_PORT)}/api/catalog/v1`;
    const error = await waitForReady(apiUrl);

    writeHandoff({
      apiUrl,
      apiKey: API_KEY,
      image,
      imageId,
      containerId: crawler.getId(),
      postgresUri: postgres.getConnectionUri(),
      error,
    });

    console.log(`\n  crawler: ${image} (${imageId}) on ${apiUrl}\n`);
  } catch (err) {
    // An image that cannot start is the same kind of problem as a missing
    // one: a broken artifact, in another repository. The contract test fails
    // with the message; the rest of the suite still runs.
    const detail = err instanceof Error ? err.message : String(err);
    writeHandoff({
      apiUrl: null,
      apiKey: null,
      image,
      imageId,
      containerId: null,
      postgresUri: null,
      error:
        `the crawler container for "${image}" could not be started: ${detail}. ` +
        'Check that the image is the one that serves the catalog API.',
    });
    console.log(`\n  ⚠ the crawler container could not be started — the contract test will fail\n`);
  }
}

/**
 * Extra environment for the crawler container.
 *
 * `CONTRACT_CRAWLER_ENV` is a JSON object of `NAME=value` pairs, merged over
 * the defaults above. It exists because the crawler's seeding switch is
 * whatever the crawler decides it is: the storefront should not have to be
 * edited when that name changes, and the contract test should not be the
 * place where a guess about another repository's configuration lives.
 */
function extraCrawlerEnvironment(): Record<string, string> {
  const raw = (process.env.CONTRACT_CRAWLER_ENV ?? '').trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`CONTRACT_CRAWLER_ENV is not valid JSON: ${raw}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CONTRACT_CRAWLER_ENV must be a JSON object of NAME=value pairs');
  }

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    out[name] = String(value);
  }
  return out;
}

export async function teardown(): Promise<void> {
  const crawler = globalThis.__catalogCrawlerStarted;
  globalThis.__catalogCrawlerStarted = undefined;
  if (crawler) await crawler.stop();

  const postgres = globalThis.__catalogPostgresStarted;
  globalThis.__catalogPostgresStarted = undefined;
  if (postgres) await postgres.stop();

  const network = globalThis.__catalogNetworkStarted;
  globalThis.__catalogNetworkStarted = undefined;
  if (network) await network.stop();

  if (connectionDir) {
    rmSync(connectionDir, { recursive: true, force: true });
    connectionDir = null;
    connectionFile = null;
  }
}

/**
 * The hand-over file, as the main process knows it.
 *
 * The workers do not use this: they find the file themselves, by scanning the
 * temp directory for the newest one. The reason is in the old setup file and
 * it still holds — a run that was interrupted leaves its directory behind, and
 * picking a stale one means connecting to a container that has already been
 * stopped.
 */
export function contractEnvironmentPath(): string | null {
  return connectionFile;
}
