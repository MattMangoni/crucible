---
name: crucible
description: Autonomous software factory for T3 Code and coding agents. Runs heavy upfront grilling and an optional Spec Council to lock a spec and autonomy contract, then executes autonomously through isolated worktree implementation, deterministic verification, DRY/KISS tidying, bounded multi-model council review, PR creation, CI fixing, marking ready, and ongoing PR comment watching — everything except merging. Supports both single-task runs and parallel batch runs. Use when the user asks to run crucible, start a software factory run, or run an autonomous end-to-end ticket-to-PR pipeline.
argument-hint: "[batch] [<ticket-or-brief>]"
---

# Crucible

`heavy grill (+ Spec Council) → GO → implement → verify → tidy → council loop → PR open → CI green → mark ready → watch PR`

Crucible puts all ambiguity resolution up front, then runs autonomously to a green, council-approved, ready-for-review pull request while enforcing deterministic gates through the `crucible` CLI.

## Hard invariants (never overridable)

1. **Never merge a pull request.** Stop at ready-for-review and keep watching until a human merges or closes it.
2. **Never force-push** or rewrite published branch history.
3. **Never bypass `crucible gate` or `crucible budget`.** If a gate fails, satisfy the missing condition. If a budget is exhausted, pause (`crucible pause`) and escalate to the user with a concise brief.
4. **Never run heavy commands outside `crucible lock` / `crucible verify`.** Tests, builds, typechecks, linters, installs, and `dev` merges always run through the machine-wide heavy-command lock so parallel runs never exhaust memory.
5. **Keep target repos clean.** All run state (`spec.md`, `contract.json`, `state.json`, `rebuttals.md`, `council/`) lives in `~/.local/state/crucible/runs/...`, never inside the repository working tree.
6. **Limit user interruptions after `GO`.** Only pause and ask the user on: product/scope changes, architectural disagreements that survive the council round cap, non-trivial merge conflicts, missing secrets/access, or an exhausted budget.

## Setup & configuration

Before starting any run, inspect the resolved configuration for the target repository:

```sh
crucible config --repo <repo-dir>
```

Read the repository's `AGENTS.md` (or `CLAUDE.md`) as well. If `hooks.workflowSkill` is set in the resolved config, load and follow that skill's repo-specific conventions alongside the signed run contract. Where the signed `contract.json` explicitly grants an autonomy permission (for example `pr.markReadyOnGreen: true`), it overrides default manual-confirmation pauses for that run—except the hard invariants above.

## Modes

### Mode A: Single-task run (`/crucible <brief-or-ticket>`)

1. **Intake & Grill** — Follow [references/grill.md](references/grill.md).
   - Run `crucible init <slug> --repo <repo-dir> --base <base> --branch <branch> [--ticket <url>]`.
   - Interrogate every ambiguity until zero guesswork remains.
   - Run the upfront Spec Council when `council.specCouncil` is `"always"`, or `"auto"` for medium/large changes.
   - Finalize `spec.md` and confirm the autonomy contract. Wait for the user's explicit **GO**, then run `crucible sign <run-dir>`.
2. **Worktree handoff** — If running in T3 Code and not already attached to a dedicated worktree (check `t3_worktree_status`), call `t3_worktree_handoff` for `contract.branch` with a `continuationPrompt` that names `<run-dir>` and resumes at **Step 3 (Implement)**. If `hooks.postWorktreeSetup` is configured, run it right after entering the worktree.
3. **Implement & Verify** —
   - Implement strictly to `<run-dir>/spec.md`. Do not add speculative scope.
   - Commit logical changes using the repo's commit conventions.
   - Run verification commands under `crucible verify <run-dir> -- <verify-command>`.
   - Advance the gate: `crucible gate <run-dir> tidy`.
4. **Tidy** — Follow [references/tidy.md](references/tidy.md).
   - Run the 2-agent read-only DRY/KISS cleanup pass, apply valid fixes, commit, re-run `crucible verify`, and run `crucible record-tidy <run-dir>`.
   - Advance the gate: `crucible gate <run-dir> council`.
5. **Council Loop** — Follow [references/council.md](references/council.md).
   - Run bounded hub-and-spoke multi-model review rounds (default max 3 rounds) until `0` blockers and every council member scores `>= minScore` (default `9/10`).
   - Record every round with `crucible record-council`. If a round requires edits, commit and re-run `crucible verify` before the next round (plus a quick tidy check on heavily refactored files).
   - Advance the gate: `crucible gate <run-dir> pr-open`.
6. **PR Open, CI Green & Mark Ready** — Follow [references/pr-open.md](references/pr-open.md).
   - Run optional `hooks.prePrOpen` / `hooks.prePrOpenSkill`, open a draft PR with the council score table in the description, record it with `crucible record-pr`, and watch CI via `watch_pull_request`.
   - Auto-fix CI failures within `budgets.ciFixPushes`. Once CI is green on `HEAD`, run `crucible record-ci --status green`, `crucible gate <run-dir> pr-ready`, and mark the PR ready for review (never merge).
7. **Autonomous PR Watch & Comments** — Follow [references/pr-comments.md](references/pr-comments.md) and [references/comment-voice.md](references/comment-voice.md).
   - Advance to `crucible gate <run-dir> pr-watch` and keep watching with `watch_pull_request`, handling incoming review comments (fixing valid issues, rebutting false positives, replying in the comment voice) and clean base conflicts within `budgets.prWatchPushes`.

### Standalone PR utilities

You can also invoke Crucible's built-in PR playbooks directly outside a full factory run:
- **Open a PR:** follow [references/pr-open.md](references/pr-open.md)
- **Handle / watch PR comments:** follow [references/pr-comments.md](references/pr-comments.md)
- **Draft or post a PR comment:** follow [references/comment-voice.md](references/comment-voice.md)
- **Check what PRs need attention:** run `crucible attention` and follow [references/pr-attention.md](references/pr-attention.md)

### Mode B: Parallel batch run (`/crucible batch`)

Use this when the user brings multiple tickets or independent tasks to run in parallel.

1. **Map dependencies first.** Partition the tasks into:
   - **Independent tasks** — safe to run concurrently in separate worktrees from `origin/<default-branch>`.
   - **Stacked tasks** — dependent changes where task B builds on task A's branch (`startFromOrigin: false`, `baseRef` = A's branch).
2. **Grill every task up front** in this coordinator thread (one concise spec per task, running `crucible init` for each, with Spec Council for medium/large items).
3. **Confirm provider spread (optional).** Call `orchestrator_capabilities` once to see available subscription providers/models. If multiple providers are enabled, you may spread spawned worker threads across providers to avoid saturating one subscription's rate limit.
4. **Wait for batch GO**, then run `crucible sign <run-dir>` for each approved task.
5. **Fan out via `t3_thread_launch`:** spawn one top-level thread per independent task with `workspaceStrategy: { type: "worktree", baseRef: ..., branch: ..., startFromOrigin: true }`. Give each spawned thread a self-contained prompt pointing to its `<run-dir>` (`spec.md`, `contract.json`) and instructing it to execute **Crucible Steps 3–6** (starting with `hooks.postWorktreeSetup` if configured, and running all heavy commands through `crucible lock` / `crucible verify`).
6. **Report links verbatim** using each launched thread's `link` field, plus `crucible status --all` so the user can monitor every run at a glance.

## Resuming or checking status

- Check all runs: `crucible status --all`
- Check one run: `crucible status <run-dir>`
- When resuming a paused run after user input, update `spec.md` (if scope changed), clear the pause via the next valid `crucible gate`, and continue from the recorded phase.
