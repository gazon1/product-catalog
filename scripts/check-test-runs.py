#!/usr/bin/env python3
"""check-test-runs.py — fail when a test file did not execute, or executed fewer tests than recorded.

## The defect this catches

`npm test` exits 0 and prints a summary whether 138 tests ran or one file was
excluded by a typo in `include`, a wrong `--project` flag, or a filter added to
the npm script to make some unrelated run faster. Nothing about that is
visible in the exit code. The 30 tests in `database.test.ts` are the ones that
need a container, so they are also the ones a broken selection drops first —
and they are the entire reason this repository has an integration suite.

Docker's absence is already handled separately and loudly: `tests/global-setup.ts`
throws rather than skipping. This gate covers the remaining hole, which is a
suite that is never *selected*, and therefore never reaches a code path that
could have complained.

## Why per-file, and not one total

A single floor — "at least 138 tests ran" — does not catch the case this gate
exists for. Dropping `database.test.ts` removes 30 tests, but every one of the
other files keeps passing, and any test added later raises the total back over
the line. The number stays green while the thing being protected is gone.

So each file gets its own floor, and a file that is absent from the results is
a failure in its own right rather than a line item in a total.

This deliberately differs from the crawler's `check-test-runs.py`, which floors
one count per Gradle module and documents the resulting blind spot. There the
exposure is "someone adds a test and the task stops selecting it"; here it is
"the only suite that touches a database stops running", which is a failure this
repository has already had to guard against once. The divergence is recorded
rather than silently accepted — see README, «Проверка».

## Why a floor and not an exact count

An exact count would fail every legitimate test addition. A floor fails only
when a run executes *fewer* than has ever been recorded, which is the direction
that hides breakage. More tests is always an improvement.

## Refusing to skip

A missing results file is a failure, not an empty result. Treating "no output"
as "no tests" is precisely how a green build hides a suite that never started.

## Usage

    python3 scripts/check-test-runs.py [--update]

## Exit codes

    0 — every recorded file met or beat its floor, and every recorded file ran
    1 — a file ran fewer tests than its floor, or did not run at all
    2 — results or floor file missing or unreadable
"""

from __future__ import annotations

import argparse
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "build" / "test-results" / "vitest.xml"
FLOOR_FILE = ROOT / "config" / "test-runs-floor.tsv"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def parse_floor(path: Path | None = None, allow_missing: bool = False) -> dict[str, int]:
    """Read `<file> <min-count>` rows.

    The path is a parameter so the parser can be exercised against a fixture
    rather than by editing the real configuration — a parser that can only be
    tested by changing production config is a parser nobody tests.

    `allow_missing` exists for `--update`: regenerating the file must not depend
    on the file already existing, or the first run of a new gate needs a
    hand-created placeholder that has to be deleted again.
    """
    target = path or FLOOR_FILE
    if not target.exists():
        if allow_missing:
            return {}
        raise FileNotFoundError(f"{target} does not exist")

    floors: dict[str, int] = {}
    for lineno, line in enumerate(target.read_text(encoding="utf-8").splitlines(), 1):
        row = line.split("#", 1)[0].strip()
        if not row:
            continue
        parts = row.split()
        if len(parts) != 2:
            raise ValueError(f"{target}:{lineno}: expected `<file> <min-count>`, got {row!r}")
        try:
            floors[parts[0]] = int(parts[1])
        except ValueError as exc:
            raise ValueError(f"{target}:{lineno}: count is not an integer: {parts[1]!r}") from exc
    return floors


def counts_from_results(path: Path) -> dict[str, int]:
    """Map each `<testsuite>` name to its executed test count.

    vitest's junit reporter names a suite after the test file, which is what
    makes a per-file floor possible. Names are normalised to repo-relative
    POSIX paths so the floor file does not depend on the reporter's absolute
    paths or on the checkout directory.
    """
    if not path.exists():
        raise FileNotFoundError(f"{rel(path)} does not exist — run `npm test` first")

    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as exc:
        raise ValueError(f"{rel(path)} is not valid XML ({exc})") from exc

    counts: dict[str, int] = {}
    for suite in root.iter("testsuite"):
        name = suite.get("name") or ""
        normalised = name.replace("\\", "/").lstrip("./")
        # Some reporters prefix with the project root; keep the trailing
        # `tests/...` portion so `tests/database.test.ts` matches either way.
        marker = "tests/"
        if marker in normalised:
            normalised = normalised[normalised.index(marker) :]
        ran = sum(1 for _ in suite.iter("testcase"))
        counts[normalised] = counts.get(normalised, 0) + ran

    if not counts:
        raise ValueError(f"{rel(path)} contains no <testsuite> — nothing executed")
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description="Fail when a test file did not execute.")
    parser.add_argument(
        "--update",
        action="store_true",
        help="rewrite the floor file from the current results instead of comparing",
    )
    args = parser.parse_args()

    try:
        floors = parse_floor(allow_missing=args.update)
        measured = counts_from_results(RESULTS)
    except (FileNotFoundError, ValueError) as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 2

    problems: list[str] = []

    for name in sorted(floors):
        floor = floors[name]
        if name not in measured:
            problems.append(f"{name}: did not run at all (floor is {floor})")
            continue
        ran = measured[name]
        if ran < floor:
            problems.append(f"{name}: ran {ran} tests, floor is {floor}")
        else:
            print(f"  ·  {name}: {ran} tests (floor {floor})")

    # A file with tests but no floor is reported, not silently accepted: the
    # floor file is the record of what is known to have executed, and a new file
    # belongs in it so that its *absence* later is detectable.
    for name in sorted(set(measured) - set(floors)):
        problems.append(f"{name}: ran {measured[name]} tests but has no floor — run with --update")

    if args.update:
        lines = [
            "# Executed-test floors, one row per test file: `<file> <min-count>`.",
            "# Managed by scripts/check-test-runs.py --update.",
            "#",
            "# Per file, not per suite total: a total would let one file's growth mask",
            "# another's disappearance, and database.test.ts is the one that must not",
            "# disappear — it is the only file that talks to a database.",
            "#",
            "# Raise in the same commit that adds tests. Lowering is allowed only when",
            "# tests are genuinely deleted, and the commit should say which.",
            "",
        ]
        for name in sorted(measured):
            lines.append(f"{name}\t{measured[name]}")
        FLOOR_FILE.parent.mkdir(parents=True, exist_ok=True)
        FLOOR_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print("✅ floor file updated from the current run")
        return 0

    if problems:
        print("", file=sys.stderr)
        for problem in problems:
            print(f"❌ {problem}", file=sys.stderr)
        print(
            "\nA green `npm test` is not evidence that a suite executed. This check reads\n"
            "the JUnit XML the run produced. A file missing from it did not run, whatever\n"
            "the exit code was.",
            file=sys.stderr,
        )
        return 1

    total = sum(measured[name] for name in floors)
    print(f"✅ {len(floors)} file(s), {total} tests executed, all floors met")
    return 0


if __name__ == "__main__":
    sys.exit(main())