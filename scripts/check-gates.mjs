#!/usr/bin/env node
//
// check-gates.mjs — check that the CI and `just check` run the same gates.
//
// WHAT THIS CHECKS
//
// The gates live in config/gates.yaml, and both the CI and `just check` are
// supposed to run them from there. This script looks at both sides and says
// where they differ:
//
//   1. the CI runs the list (a step runs scripts/run-gates.mjs);
//   2. the CI does not run a gate on its own — a gate that is written down in
//      the workflow as well is a gate that will be updated in one place only;
//   3. `just check` runs the list, and does not enumerate gates as its
//      dependencies — the old way, which is how the two lists drifted apart.
//
// THE REQUIRED CHECKS OF main
//
// A gate that nobody waits for is a report, not a gate. The repository's
// branch protection names the checks that must be green before a pull
// request merges, and this script compares those names with the jobs the
// workflows define: a required check that is not a job of any workflow can
// never be green, and the pull request waits for it forever.
//
// The comparison needs the repository's API and a token. Without one the
// check says that it could not check — it does not say that everything is
// fine. A gate that cannot honestly pass is worse than no gate.
//
// Usage: node scripts/check-gates.mjs

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadGates } from './gates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = 'scripts/run-gates.mjs';

/** What is wrong, if anything. Each entry says which side drifted. */
const problems = [];

function fail(message) {
  problems.push(message);
}

// ── the gates ─────────────────────────────────────────────────────────────────

const gates = loadGates();
const gateCommands = new Map(gates.map((gate) => [gate.command, gate.id]));

// ── the CI ───────────────────────────────────────────────────────────────────

const ciFile = join(ROOT, '.github', 'workflows', 'ci.yml');
const ci = parse(readFileSync(ciFile, 'utf8'));

/** Every step of every job of a workflow, with the job's name. */
function stepsOf(workflow) {
  const steps = [];
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      steps.push({ jobName, step });
    }
  }
  return steps;
}

/** Every workflow of the repository, with its file name. */
function workflows() {
  const directory = join(ROOT, '.github', 'workflows');
  return readdirSync(directory)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => ({ file, workflow: parse(readFileSync(join(directory, file), 'utf8')) }));
}

const ciSteps = stepsOf(ci);

const runnerSteps = ciSteps.filter(({ step }) =>
  typeof step.run === 'string' && step.run.includes(RUNNER),
);

if (runnerSteps.length === 0) {
  fail(
    `the CI does not run the gate list: no step of .github/workflows/ci.yml runs ${RUNNER}, ` +
      'so the pipeline checks whatever it happens to check.',
  );
}

// A gate that the CI runs on its own is a gate that will be updated in one
// place only — and the place nobody reads.
for (const { jobName, step } of ciSteps) {
  if (typeof step.run !== 'string') continue;
  for (const line of step.run.split('\n')) {
    const command = line.trim();
    const gateId = gateCommands.get(command);
    if (gateId !== undefined) {
      fail(
        `the job "${jobName}" runs the gate "${gateId}" on its own ("${command}"), ` +
          `and the gates live in config/gates.yaml — remove the step, or take the gate out of the list.`,
      );
    }
  }
}

// The other workflows have their own triggers and their own reasons — the
// contract types' staleness, the crawler's dispatch — and they run a part of
// the list. That is not a drift: a part of the list is a part of the list.
// What would be a drift is a gate that exists only there, and that is what
// the report below is for.
for (const { file, workflow } of workflows()) {
  if (file === 'ci.yml') continue;
  const used = new Set();
  for (const { step } of stepsOf(workflow)) {
    if (typeof step.run !== 'string') continue;
    for (const line of step.run.split('\n')) {
      const gateId = gateCommands.get(line.trim());
      if (gateId !== undefined) used.add(gateId);
    }
  }
  if (used.size > 0) {
    console.log(`the workflow ${file} runs the gates ${[...used].join(', ')} — a part of the list`);
  }
}

// ── the justfile ─────────────────────────────────────────────────────────────

const justfile = readFileSync(join(ROOT, 'justfile'), 'utf8');

/** The recipe of the justfile, with its dependencies and its body. */
function recipe(name) {
  const lines = justfile.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${name}:(\\s|$)`).test(line));
  if (start < 0) return null;

  const dependencies = lines[start].slice(name.length + 1).trim();
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break;
    body.push(line.trim());
  }
  return { dependencies, body: body.join(' ') };
}

const check = recipe('check');

if (check === null) {
  fail('the justfile has no `check` recipe — the local run has no gates at all.');
} else {
  if (!check.body.includes(RUNNER)) {
    fail(
      `just check does not run the gate list: it runs "${check.dependencies || '(nothing)'}", ` +
        `and the gates live in config/gates.yaml — the recipe has to run ${RUNNER}.`,
    );
  }

  // Dependencies that are gates would run them a second time, in the order the
  // justfile happens to have — which is the old list, still alive.
  const gateIds = new Set(gates.map((gate) => gate.id));
  const asGates = check.dependencies
    .split(/\s+/)
    .filter((dependency) => gateIds.has(dependency));
  if (asGates.length > 0) {
    fail(
      `just check still lists gates as dependencies (${asGates.join(', ')}), ` +
        `and runs the list as well — the list is in config/gates.yaml, so the dependencies go.`,
    );
  }
}

// ── the required checks of main ──────────────────────────────────────────────

/** The repository the checks belong to. */
function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;

  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\s*$/.exec(remote.stdout ?? '');
  return match ? match[1] : null;
}

/** The job names of every workflow in the repository. */
function jobNames() {
  const names = new Set();
  for (const { workflow } of workflows()) {
    for (const name of Object.keys(workflow.jobs ?? {})) names.add(name);
  }
  return names;
}

/**
 * The checks that main's branch protection waits for.
 *
 * `checked: false` means the check could not be made — the reason says why,
 * and it is printed, because a gate that could not check must not look like a
 * gate that checked.
 */
function requiredChecks(repo) {
  if (repo === null) {
    return { checked: false, reason: 'the repository is not known (no GITHUB_REPOSITORY, no origin remote)' };
  }

  // The token comes from the environment when there is one — the CI passes its
  // own — and from the gh's own login otherwise. Without either the call
  // fails, and the reason says so.
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null;

  const result = spawnSync(
    'gh',
    ['api', `repos/${repo}/branches/main/protection/required_status_checks`],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: token === null ? process.env : { ...process.env, GH_TOKEN: token },
    },
  );

  if (result.status !== 0) {
    const reason =
      (result.stderr ?? '').trim().split('\n')[0] ||
      (token === null
        ? 'gh is not logged in and there is no token in the environment'
        : `gh exited ${result.status}`);
    return { checked: false, reason };
  }

  let contexts;
  try {
    contexts = JSON.parse(result.stdout).contexts ?? [];
  } catch (error) {
    return { checked: false, reason: `the API answered with something unreadable: ${error.message}` };
  }
  return { checked: true, contexts };
}

const repo = repository();
const required = requiredChecks(repo);

if (!required.checked) {
  console.log(`⚠️  the required checks of main were NOT checked: ${required.reason}.`);
  console.log('   Check them yourself: gh api repos/<owner>/<repo>/branches/main/protection/required_status_checks');
} else {
  const jobs = jobNames();
  for (const context of required.contexts) {
    if (!jobs.has(context)) {
      fail(
        `main waits for the check "${context}", and no workflow has a job with that name — ` +
          'the pull requests wait for something that can never be green.',
      );
    }
  }
  console.log(`the required checks of main: ${required.contexts.join(', ')}`);
}

// ── the verdict ──────────────────────────────────────────────────────────────

if (problems.length > 0) {
  console.error('');
  for (const problem of problems) {
    console.error(`❌ ${problem}`);
  }
  console.error('');
  console.error('The CI and `just check` must run the same gates — one list: config/gates.yaml.');
  process.exit(1);
}

console.log('✅ the CI and `just check` run the same gates');
