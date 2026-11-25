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
2. Give each member:
   - The git diff against `contract.base` (and changed file paths to read in full)
   - `<run-dir>/spec.md` (the authoritative requirements and non-goals)
   - `<run-dir>/rebuttals.md` (from prior rounds, if Round > 1)
   - Explicit instructions:
     - Read-only; do **not** run builds, linters, or tests.
     - Focus on **substantive issues** (correctness, bugs, security, data loss, race conditions, spec compliance, architectural flaws). Ignore stylistic nits and speculative scope creep.
     - Every finding must include: `severity` (`blocker` | `major` | `minor`), `file:line`, concrete failure scenario (`input/state → wrong result`), and suggested fix.
     - On Round > 1, inspect `rebuttals.md`: drop settled points, or explicitly push back if a rebuttal is wrong.
     - End with an integer score out of 10 (`Score: X/10`).
3. Do not edit files while any council delegate is still reading the checkout. As results arrive, inspect findings against the actual code and `spec.md`.

## Judging findings & updating state

1. Archive the round's synthesized findings into `<run-dir>/council/round-<N>.md`.
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
   - `passed: true` (`blockers === 0` and all scores `>= minScore`) → proceed to `crucible gate <run-dir> pr-open`.
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
