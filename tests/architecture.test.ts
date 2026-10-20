import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSortOrder, SORT_ORDERS } from '@/lib/types';
import { parseContractDocument } from './global-setup';

/**
 * Architectural gate: this repository must not touch a database at all.
 *
 * The storefront used to read the crawler's PostgreSQL directly, under a
 * SELECT-only role, with three enforcement levels: the role, the
 * `default_transaction_read_only` session option, and this file's check that
 * no statement in this repository writes. Two of the three lived in a module
 * that has since been deleted, because the storefront no longer has a
 * connection to make read-only.
 *
 * The boundary is now one thing, and it is a stronger one: **the storefront has
 * no database driver, no connection string and no SQL.** It reads the catalog
 * over the crawler's HTTP API. A site that cannot open a connection cannot
 * break the crawler's schema, cannot accidentally write to it, and cannot keep
 * "working" against a schema that a migration has renamed — which is exactly
 * the class of failure the old three-level guard existed to prevent.
 *
 * What is left to check here is the *shape* of that boundary: no driver in the
 * dependency tree, no connection string in the environment, no table names and
 * no SQL in the source.
 */
const SRC = resolve(__dirname, '..', 'src');

function read(relative: string): string {
  return readFileSync(resolve(SRC, relative), 'utf8');
}

/**
 * Strip comments before scanning source for SQL keywords.
 *
 * The write gate used to match against the raw file, prose included, and fired on
 * this sentence in `queries.ts`: "a typed second *copy* of the projection". `COPY`
 * is a SQL write statement, "copy" in an English comment is not — and the fix
 * that was available at the time was to reword the comment. That is the wrong fix
 * for a gate: it makes the gate pass by changing what it inspects, so the next
 * author has to know about the trap instead of the code being safe on its own.
 *
 * The same class of defect was already found and fixed on the crawler side, where
 * the gate-wiring checker is required to skip comments for exactly this reason.
 * Two repositories enforcing one contract should not disagree about whether a
 * comment is code.
 *
 * `//` preceded by `:` is not a comment: it is the `//` in a URL inside a string
 * literal, and treating it as a comment would silently truncate the rest of the
 * line — the line where a real write could be hiding.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the comment stripper this gate depends on', () => {
  // Without these, `stripComments` could quietly stop working and take the write
  // gate with it: a no-op stripper still passes the real files.
  it('removes a JSDoc block', () => {
    expect(stripComments('/** INSERT INTO t */\nconst a = 1;')).not.toContain('INSERT');
  });

  it('removes a trailing line comment', () => {
    expect(stripComments('const a = 1; // DELETE FROM t')).not.toContain('DELETE');
  });

  it('keeps code after a line comment marker on an earlier line', () => {
    const source = '// a note\nconst sql = `TRUNCATE t`;';
    expect(stripComments(source)).toContain('TRUNCATE');
  });

  it('does not mistake the // in a URL for a comment', () => {
    const source = "const u = 'https://wb.ru/x'; const sql = `DROP TABLE t`;";
    expect(stripComments(source)).toContain('DROP TABLE');
  });

  it('strips block comments but keeps a SQL keyword that shares the file with them', () => {
    const source = '/** why GRANT appears here */\nconst sql = `GRANT SELECT ON t TO r`;';
    const stripped = stripComments(source);
    expect(stripped).not.toContain('GRANT appears');
    expect(stripped).toContain('GRANT SELECT');
  });
});

/**
 * Blank out the contents of plain string and regular-expression literals.
 *
 * The gate has to tell *code* from *text*, and the two are not the same thing:
 *
 *   - `import { Pool } from 'pg'` is a database driver, and the token lives in
 *     a string literal;
 *   - `className="truncate text-xs"` is a Tailwind utility, and it lives in a
 *     string literal too;
 *   - `hint="В базе краулера нет ни одной записи в crawl_targets"` is a
 *     sentence a visitor reads, and the token lives in a string literal as well.
 *
 * A gate cannot fire on the first and stay quiet on the second, so the checks
 * are run against different sources:
 *
 *   - the **connection** tokens are matched with the literals intact — a
 *     connection string in a string literal is still a connection string;
 *   - the **schema names** and the **write statements** are matched with the
 *     plain literals blanked, because a table name in a sentence is not a
 *     query. Template literals are *not* blanked: SQL in this repository is
 *     written in backticks, and a template literal is where a statement would
 *     hide.
 *
 * The comment stripper is applied first, so a keyword in a comment is gone
 * before any check runs.
 */
function blankPlainLiterals(source: string): string {
  let out = '';
  let i = 0;

  /** Whether a `/` at this position starts a regular expression, not a division. */
  const startsRegex = (): boolean => {
    const before = out.replace(/\s+$/, '').slice(-1);
    if (before === '') return true;
    return '(,=:[!&|?{};+-*%~^<>'.includes(before);
  };

  while (i < source.length) {
    const ch = source[i]!;

    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }

    // A template literal is kept: it is where SQL would be written.
    if (ch === '`') {
      const start = i;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '`') {
          i += 1;
          break;
        }
        i += 1;
      }
      out += source.slice(start, i);
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }

    if (ch === '/' && startsRegex()) {
      i += 1;
      let inClass = false;
      while (i < source.length) {
        const c = source[i]!;
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          i += 1;
          break;
        } else if (c === '\n') break;
        i += 1;
      }
      out += ' ';
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/** Every source file under `src/`, recursively. */
function sourceFiles(dir = SRC): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

/** The path of a file relative to `src/`, for a readable failure message. */
function relative(file: string): string {
  return file.slice(SRC.length + 1);
}

describe('the storefront never touches a database', () => {
  /**
   * The connection tokens, matched with the string literals intact.
   *
   * A connection string, a driver import or a pool is a connection whatever
   * it is written in, and none of these words appears in prose by accident:
   * `postgres://` is a URL scheme and `pg.Pool` is a class.
   */
  const CONNECTION_TOKENS = [
    /from ['"]pg['"]/,
    /require\(\s*['"]pg['"]\s*\)/,
    /\bpg\.Pool\b/,
    /postgres:\/\//,
    /postgresql:\/\//,
  ];

  /**
   * The schema and the credential names.
   *
   * These are the words that a *sentence* may legitimately contain — a hint
   * that tells a visitor which table to look at, an error message that names
   * the variable that was not set. They are the crawler's vocabulary, and the
   * site's own text is allowed to talk about them. What is not allowed is the
   * site *using* them, and the blanked-literal source is what shows the
   * difference.
   */
  const SCHEMA_TOKENS = [
    /\bDATABASE_URL\b/,
    /\bscraped_items\b/,
    /\bcrawl_targets\b/,
    /\bpg\b/,
  ];

  /**
   * The write statements.
   *
   * The check is case-sensitive, and that is deliberate. The SQL in this
   * repository is written in uppercase, and the one lowercase word that would
   * false-positive is `truncate` — a Tailwind utility that every card in this
   * site uses. A gate that fires on a CSS class is a gate that people learn
   * to switch off.
   */
  const WRITE_STATEMENTS =
    /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(TABLE|INDEX|SCHEMA)|ALTER\s+TABLE|CREATE\s+(TABLE|INDEX|UNIQUE|SCHEMA)|TRUNCATE|GRANT|REVOKE|COPY)\b/;

  it('finds the source files to scan', () => {
    // A gate that scans nothing passes. This is the assertion that the scan
    // itself is not empty.
    expect(sourceFiles().length).toBeGreaterThan(10);
  });

  it('contains no database connection', () => {
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      const source = stripComments(read(file));
      for (const token of CONNECTION_TOKENS) {
        const match = source.match(token);
        if (match) violations.push(`${relative(file)}: "${match[0]}"`);
      }
    }

    expect(
      violations,
      violations.join('\n') +
        '\n\nThe storefront reads the catalog over the crawler\'s HTTP API. It has no ' +
        'credentials, no driver and no connection string, and a site that cannot open a ' +
        'connection cannot break the crawler\'s schema.',
    ).toEqual([]);
  });

  it('uses no schema name in code', () => {
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      const source = blankPlainLiterals(stripComments(read(file)));
      for (const token of SCHEMA_TOKENS) {
        const match = source.match(token);
        if (match) violations.push(`${relative(file)}: "${match[0]}"`);
      }
    }

    expect(
      violations,
      violations.join('\n') +
        '\n\nThe crawler owns the schema; the storefront owns the vocabulary of its own ' +
        'API, and those are two different things. A table name in a sentence a visitor ' +
        'reads is fine — a table name in code is not.',
    ).toEqual([]);
  });

  it('contains no write statement', () => {
    const violations: string[] = [];
    for (const file of sourceFiles()) {
      const source = blankPlainLiterals(stripComments(read(file)));
      const match = source.match(WRITE_STATEMENTS);
      if (match) violations.push(`${relative(file)}: "${match[0]}"`);
    }

    expect(
      violations,
      violations.join('\n') +
        '\n\nThe storefront does not write to the catalog — it cannot, and it must not.',
    ).toEqual([]);
  });

  // The counterpart to the tests above: the checks must not have been
  // disarmed. Verified against snippets that never touch the real source tree,
  // so proving it costs nothing and cannot itself drift.
  it('still fires on a write that is not in a comment', () => {
    const planted = 'const sql = `UPDATE scraped_items SET title = $1 WHERE id = $2`;';
    expect(blankPlainLiterals(stripComments(planted))).toMatch(WRITE_STATEMENTS);
  });

  it('does not fire on a write keyword that only appears in a comment', () => {
    const planted = '/** never INSERT INTO scraped_items here */\nconst sql = `SELECT 1`;';
    expect(blankPlainLiterals(stripComments(planted))).not.toMatch(WRITE_STATEMENTS);
  });

  it('fires on a schema name used in code', () => {
    const planted = 'const sql = `SELECT * FROM scraped_items`;';
    expect(blankPlainLiterals(stripComments(planted))).toMatch(/\bscraped_items\b/);
  });

  it('does not fire on a schema name mentioned in a sentence', () => {
    // The site's own hint text names the crawler's table, and it is allowed
    // to: that is prose for a visitor, not a query for the database.
    const planted = 'const hint = "В базе краулера нет ни одной записи в crawl_targets.";';
    expect(blankPlainLiterals(stripComments(planted))).not.toMatch(/\bcrawl_targets\b/);
  });

  it('does not fire on a Tailwind class that is called truncate', () => {
    const planted = 'const className = "truncate text-xs text-slate-500";';
    expect(blankPlainLiterals(stripComments(planted))).not.toMatch(WRITE_STATEMENTS);
  });
});

describe('the dependency tree has no database driver', () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it('does not depend on a PostgreSQL driver', () => {
    // Not "does not use it" — does not *have* it. A driver in the tree is a
    // driver that can be imported by the next person on a bad day, and the
    // whole point of the boundary is that this site cannot open a connection.
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('pg');
  });

  it('does not depend on the driver’s types either', () => {
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain('@types/pg');
  });
});

describe('sort order is a closed set', () => {
  it('accepts only declared values', () => {
    for (const order of SORT_ORDERS) {
      expect(isSortOrder(order)).toBe(true);
    }
  });

  it('rejects anything else from a URL', () => {
    // This is what stops `?sort=` from reaching the API. The union type stops it
    // in the compiler; this stops it at runtime, where the value actually
    // originates.
    expect(isSortOrder('PriceDesc; DROP TABLE scraped_items')).toBe(false);
    expect(isSortOrder('scraped_at DESC')).toBe(false);
    expect(isSortOrder('')).toBe(false);
    expect(isSortOrder(null)).toBe(false);
    expect(isSortOrder(undefined)).toBe(false);
  });
});

describe('the sort names are the contract’s sort enum', () => {
  /**
   * The contract's `sort` parameter, as the document declares it.
   *
   * The site owns the names and the API owns the implementation, and the two
   * only agree if somebody checks. The check is here rather than in the
   * contract test because this file must be runnable without a crawler: a
   * closed set that drifts from the contract would send a name the API
   * rejects, and an ordinary site URL would become a `400`.
   */
  function contractSortEnum(): string[] {
    const document = parseContractDocument() as {
      paths: Record<string, { get: { parameters: Array<{ name: string; schema: { enum?: string[] } }> } }>;
    };
    const parameter = document.paths['/items']?.get.parameters.find((p) => p.name === 'sort');
    const values = parameter?.schema.enum;
    if (!values) {
      throw new Error('the contract document does not declare a `sort` enum for /items');
    }
    return values;
  }

  it('sends exactly the names the contract accepts', () => {
    expect([...SORT_ORDERS].sort()).toEqual([...contractSortEnum()].sort());
  });

  it('sends no name that the contract would reject', () => {
    const allowed = new Set(contractSortEnum());
    for (const order of SORT_ORDERS) {
      expect(allowed.has(order), `the site sends "${order}", which the contract does not declare`).toBe(
        true,
      );
    }
  });
});
