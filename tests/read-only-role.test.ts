/**
 * The read-only role is the one of the three enforcement levels that lives
 * outside this repository — the other two are `default_transaction_read_only=on`
 * per session and the write-statement gate in `architecture.test.ts`.
 *
 * ## What can be checked from here, and what cannot
 *
 * Whether the role exists in the live database cannot be checked by a test
 * without a live database, and a test that quietly passes when it cannot connect
 * is worse than no test. So this file checks the part that *is* in the repository:
 * the script that performs the grant. That script is the only artifact standing
 * between "read-only by construction" and a role with `GRANT ALL PRIVILEGES`,
 * and it is committed rather than run from a deploy step precisely so that it can
 * be reviewed — which is only worth doing if something checks it.
 *
 * The absence of write grants is the assertion that matters. A role listed in a
 * grants query proves something was granted; only the absence of write
 * privileges proves the boundary is intact.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '..', 'deploy', 'provision-readonly-role.sql');
const sql = readFileSync(SCRIPT, 'utf8');

/** Statements that actually execute, with comments removed. */
function statements(): string[] {
  return sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('the provisioning script grants nothing but read access', () => {
  // PostgreSQL privilege letters: r=SELECT w=INSERT a=UPDATE D=DELETE
  // C=CREATE T=TRUNCATE X=REFERENCES. The grant list below is restricted to
  // SELECT and USAGE; a `GRANT ALL` or a stray INSERT grant would land here.
  const WRITABLE = /\b(INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL\s+PRIVILEGES|ALL)\b/i;

  it.each(statements().filter((s) => /\bGRANT\b/i.test(s)))(
    'grants only read privileges: %s',
    (statement) => {
      const privileges = statement.match(/\bGRANT\s+(.+?)\s+ON\b/i)?.[1] ?? '';
      expect(privileges).not.toMatch(WRITABLE);
      expect(privileges.trim().toUpperCase()).toMatch(/^(CONNECT|USAGE|SELECT)$/);
    },
  );

  it('never revokes or drops anything the crawler needs', () => {
    // The script is idempotent and additive. A REVOKE or DROP here would mean
    // re-running a "provisioning" script could break the crawler it shares a
    // database with.
    expect(sql).not.toMatch(/\b(REVOKE|DROP)\b/i);
  });

  it('takes the password from a variable, never a literal', () => {
    // A literal password committed here would be a live credential in git
    // history, and the file is the one artifact an operator is told to read.
    expect(sql).toMatch(/:\s*'catalog_password'/);
    expect(sql).not.toMatch(/PASSWORD\s+'[^']+'\s*'?\s*(;|--|$)/i);
  });

  it('documents the ALTER DEFAULT PRIVILEGES step as belonging to the crawler', () => {
    // That statement only covers objects created by the role executing it.
    // Executed by an admin — which is what this file is — it covers nothing the
    // crawler will make, so a new migration's table would be invisible to the
    // storefront while this script still reported success.
    expect(sql).toMatch(/ALTER DEFAULT PRIVILEGES/i);
    expect(sql).toMatch(/run by the crawler, not by the operator/i);
  });

  it('includes a verification query, because a grant nobody checks is a promise', () => {
    // Assertions below match prose, and prose in the SQL file is wrapped across
    // lines with a `--` marker on each. Dropping the marker but keeping its text
    // — rather than stripping the comment wholesale, which would delete the very
    // sentence being asserted on — keeps the test about the sentence rather than
    // about where someone happened to break it.
    const flat = sql
      .replace(/^\s*-- ?/gm, '')
      .replace(/\s+/g, ' ');

    expect(sql).toMatch(/role_table_grants/i);
    // The negative control has to be stated, not implied.
    expect(flat).toMatch(/absence of write privileges proves the boundary is intact/i);
  });
});