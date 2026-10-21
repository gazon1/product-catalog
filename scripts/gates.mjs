//
// gates.mjs — the one list of gates.
//
// WHY A SEPARATE MODULE
//
// The list is read by two programs: the runner that executes the gates and
// the check that compares them with the CI. The reader lives here, so that
// importing it does not run the gates — the runner is a program, and a
// program that runs when it is imported is a trap for the next reader.
//

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The gates, from the one list they are written down in. */
export function loadGates() {
  const file = join(ROOT, 'config', 'gates.yaml');
  const document = parse(readFileSync(file, 'utf8'));
  const gates = document?.gates;

  if (!Array.isArray(gates) || gates.length === 0) {
    throw new Error('config/gates.yaml has no gates — the list is the whole point of it');
  }

  for (const gate of gates) {
    if (typeof gate?.id !== 'string' || typeof gate?.command !== 'string') {
      throw new Error(`every gate needs an id and a command: ${JSON.stringify(gate)}`);
    }
  }

  return gates;
}
