# Phase 3: Tidy (DRY & KISS Cleanup Pass)

Run this **after** initial implementation passes `crucible verify` and **before** the Code Council, so reviewers evaluate clean code rather than avoidable clutter.

This pass improves code quality only—it does not hunt for correctness bugs (that belongs to Phase 4).

## Design rules (take precedence over every angle)

- **DRY:** Reuse an existing helper, module, or type the first time it applies. Logic that must stay in sync (business rules, validation, mappings, constants) lives in one place from its second occurrence. For code that merely looks alike, apply the rule of three: tolerate two copies and extract on the third when the shared shape is clear. Duplication is cheaper than the wrong abstraction.
- **KISS:** No complexity the task does not need. Remove single-implementation interfaces, single-caller wrappers, unused parameters/options, config for fixed values, speculative future-proofing, and redundant defensive checks on internal data already guaranteed by types. Never weaken validation at system boundaries, error handling, or repo layering.

## Step 1: Gather the branch diff

Run `git diff <base>...HEAD` against `contract.base` (plus `git diff HEAD` if anything is uncommitted).

## Step 2: 2-agent read-only review

Launch **2 independent read-only review agents in parallel** (no tests, builds, or edits):
- **Agent A — Reuse & Simplification:** Flag re-implemented helpers (naming the existing helper), duplicated sync-critical logic, dead code, deep nesting, derivable state, and KISS violations.
- **Agent B — Efficiency & Altitude:** Flag redundant I/O or computation, sequential work that can run concurrently, closure-captured memory leaks in long-lived objects, and shallow bandaids/special cases layered over shared infrastructure when a cleaner root fix exists.

Each finding must include `file`, `line`, a one-line `summary`, and the concrete cost.

If subagent tools are unavailable, run all four angles in one careful self-pass.

## Step 3: Apply valid fixes & re-verify

1. Deduplicate overlapping findings and drop any that contradict `spec.md`, DRY, or KISS, or that would alter intended behavior.
2. Apply the remaining cleanups minimally.
3. Commit the tidy changes cleanly (if any edits were made).
4. Re-run `crucible verify <run-dir> -- <verify-command>` so `verifiedSha === HEAD`.
5. Record the tidy pass:

```sh
crucible record-tidy <run-dir> --summary "<brief summary or 'already clean'>"
crucible gate <run-dir> council
```
