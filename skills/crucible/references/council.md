# Phase 4: Bounded Multi-Model Council Loop

Crucible uses a **hub-and-spoke adversarial loop**, not unstructured agent-to-agent chatter:
- The **coordinator** owns the branch, `<run-dir>/spec.md`, and all edits.
- **Council members** stay strictly **read-only** (never edit files, never run heavy commands).
- Communication across rounds happens through updated diffs plus `<run-dir>/rebuttals.md`.

## Before each round

1. Ensure working tree is clean and `verifiedSha === HEAD`.
2. Resolve the configured `contract.council.members` via `orchestrator_capabilities` (already called once per thread). If a configured provider or model is unavailable, report it and pause instead of silently substituting.

## Running Round N

1. Launch all configured council members **in parallel** using `delegate_task` (or native read-only subagent for the coordinator's own provider when options match).
2. Scope each round intentionally so Round 1 catches everything and Round 2+ converges:
   - **Round 1 (exhaustive audit):**
     - Provide the full git diff against `contract.base` (and changed file paths to read in full) plus `<run-dir>/spec.md`.
     - Instruct members: *"This is the single exhaustive pass over the full diff. Surface every real `blocker`, `major`, and worth-fixing `minor` now — do not hold issues back for later rounds."*
   - **Round 2+ (delta convergence review):**
     - Provide `<run-dir>/spec.md`, prior round summaries (`<run-dir>/council/round-1.md` .. `round-(N-1).md`), `<run-dir>/rebuttals.md`, and the incremental diff since the previous round's recorded SHA (`git diff <prevRoundSha>..HEAD`) as the primary review target (plus the full diff against `contract.base` for context only).
     - Instruct members:
       - Verify prior accepted findings were fixed properly and check the fix hunks for regressions.
       - Inspect `rebuttals.md`: drop settled points, or explicitly push back with concrete evidence if a rebuttal is wrong.
       - **Convergence rule:** Do **not** raise new `minor`/nit findings on untouched code from earlier rounds. On untouched code, only flag a genuine **`blocker` or `major`** correctness, security, or data-loss bug that was missed earlier (prefix it `[missed-earlier]` with a concrete failure scenario).
3. Include these shared review instructions in every round's prompt (plus the member's `calibration` string verbatim if configured in `contract.council.members`):
   - Read-only; do **not** run builds, linters, or tests.
   - Focus on **substantive issues** (correctness, bugs, security, data loss, race conditions, spec compliance, architectural flaws). Ignore stylistic nits and speculative scope creep.
   - Every finding must include: `severity` (`blocker` | `major` | `minor`), `file:line`, concrete failure scenario (`input/state → wrong result`), and suggested fix.
   - **Adversarial falsification check (required before scoring ≥ 9):** Assume the diff has at least one subtle bug until you disprove it. Before giving `9/10` or `10/10`, explicitly verify and cite brief evidence for:
     1. Every Acceptance Criterion in `spec.md`
     2. Boundary, empty, invalid-input, error, and concurrency paths
     3. State transitions, cleanup, and rollback behavior
     4. Callers and contracts outside the diff
     Never award `9+` out of politeness or simply because the code reads cleanly.
   - **Severity-anchored scoring rubric** (end with `Score: X/10`; your score **must** match your findings):
     - `10/10` — 0 blockers, 0 majors, 0 meaningful minors; ready to merge as-is.
     - `9/10` — 0 blockers, 0 majors; at most `minor`/polish suggestions that do **not** warrant blocking merge. **Do not score below 9 if all findings are `minor`.**
     - `7–8/10` — 0 blockers, ≥ 1 concrete `major` issue (edge-case bug, spec gap, missing error/cleanup handling, broken invariant, missing test on a risky path).
     - `≤ 6/10` — ≥ 1 `blocker` (data loss, security flaw, crash, broken acceptance criterion, race condition, architectural flaw).
4. Do not edit files while any council delegate is still reading the checkout. As results arrive, inspect findings against the actual code and `spec.md`.

## Judging findings & updating state

1. Archive the round's synthesized findings (accepted fixes, rejected/rebutted items, and scores) into `<run-dir>/council/round-<N>.md`.
2. Record the round's scores and remaining blockers:

```sh
crucible record-council <run-dir> \
  --round <N> \
  --scores '{"Claude Opus 5.5":8,"GPT 6.2 Sol":9,"Gemini 4 Neon":8}' \
  --blockers 1 \
  --notes "Fixed race in lock cleanup; rebutted speculative caching suggestion"
```

3. Evaluate every finding on merit (you are the judge, not a rubber stamp):
   - **Valid blocker / major / clean minor** → apply the minimal fix.
   - **False positive / contradicts `spec.md` / violates DRY or KISS / scope creep** → reject and append a concise, evidence-backed entry to `<run-dir>/rebuttals.md` (citing exact file/line or spec section).
   - **Genuine product/spec ambiguity** → run `crucible pause <run-dir> --reason "..."` and escalate to the user.

4. **Check `record-council` output:**
   - `passed: true` (`blockers === 0` and every member meets `member.minScore ?? contract.council.minScore`, default `9/10`) → proceed to `crucible gate <run-dir> pr-open`.
   - `nextAction: "fix-and-reverify"`:
     1. Apply all accepted fixes and commit them.
     2. If fixes introduced non-trivial structural edits, do a quick tidy check on the touched hunks.
     3. Re-run `crucible verify <run-dir> -- <verify-command>` so `verifiedSha === HEAD`.
     4. Start Round `N + 1` with fresh `delegate_task` calls (never `t3_thread_send` on old delegates).
   - `nextAction: "escalate-to-user"` (max rounds reached without passing) → stop and report the exact remaining blockers, scores, and `rebuttals.md` summary to the user.

## Council table for the PR description

Append this table to the PR body in Phase 5:

```markdown
## Council review

Rounds: 2

| Member | Round 1 | Round 2 |
| --- | --- | --- |
| Claude Opus 5.5 | 8/10 | 9/10 |
| GPT 6.2 Sol | 9/10 | 10/10 |
| Gemini 4 Neon | 8/10 | 9/10 |
```

Never invent a score; write `no score` if a member omitted one.
