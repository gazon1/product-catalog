#!/usr/bin/env node
//
// run-gates.mjs — run the gates from config/gates.yaml, in order.
//
// WHY ONE RUNNER
//
// The gates live in one list, and both the CI and `just check` come through
// this script. A gate that is written down in two places is a gate that is
// updated in one of them; the pipeline then checks something the local run
// does not, and the promise "a green local run means a green pipeline" becomes
// a sentence in a comment.
//
// The first gate that fails stops the run: the gates after it would report
// about a tree that is already broken, and their word would mean less than
// the first failure did.
//
// Usage: node scripts/run-gates.mjs

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGates } from './gates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Run one gate and wait for it.
 *
 * The command is run through a shell, because the gates are the commands the
 * justfile and the CI used to run — `npm run build`, `python3 scripts/…` —
 * and rewriting them here would be a second list in disguise.
 */
function runGate(gate) {
  return new Promise((resolvePromise) => {
    const child = spawn(gate.command, {
      cwd: ROOT,
      shell: true,
      stdio: 'inherit',
    });

    child.on('error', (error) => {
      console.error(`\n❌ the gate "${gate.id}" could not be started: ${error.message}`);
      resolvePromise(1);
    });

    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

const gates = loadGates();

for (const gate of gates) {
  console.log(`\n▸ ${gate.id} — ${gate.what}`);

  const status = await runGate(gate);
  if (status !== 0) {
    console.error(`\n❌ the gate "${gate.id}" failed (exit ${status})`);
    process.exit(status);
  }
}

console.log('\n✅ all the gates passed');
