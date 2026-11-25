# Phases 5 & 6: PR Open, CI Green, Mark Ready & PR Watch

## Phase 5: Open PR → CI Green → Mark Ready

### 1. Enforce the pre-PR gate

```sh
crucible gate <run-dir> pr-open
```

This guarantees: contract signed, working tree clean, `tidy` recorded, `council` passed on `HEAD`, and `verifiedSha === HEAD`.

### 2. Optional hooks & PR creation

- If `contract.hooks.prePrOpen` is set, run it under `crucible lock`.
- If `contract.hooks.prePrOpenSkill` is set (for example a repo-specific PR skill), follow its PR format and repo-specific pre-PR steps—keeping the signed `contract.json` rules for marking ready and never merging/force-pushing.
- Otherwise:
  1. Ensure the branch contains the latest `contract.base` (`git fetch origin` and `git merge-base --is-ancestor <base> HEAD`). If behind and `contract.pr.autoMergeCleanBase` is true, merge `<base>` cleanly (no force-push), re-verify, and re-check council if merge touched non-trivial code; if conflicts are non-trivial, pause and escalate.
  2. Open a **draft PR** against `contract.base` using `pull_request_create` (`draft: true`) with:
     - Clear summary of what changed and why (matching the repo's title style and `contract.pr.language`)
     - Concrete verification/testing steps
     - Ticket link (if `contract.ticket` is set)
     - The `## Council review` score table from Phase 4
  3. Record the PR URL:
     ```sh
     crucible record-pr <run-dir> --url <pr-url>
     ```
  4. If `contract.hooks.postPrOpen` is set, run it.

### 3. Watch CI until green, then mark ready

1. Call `watch_pull_request` on the PR (`until: "merged"` because Phase 6 keeps handling comments/CI until a human merges it) and end your turn to wait for check updates.
2. **If CI fails:**
   - Consume CI-fix budget first: `crucible budget <run-dir> ci --consume`. If it exits non-zero, stop and escalate with the failing check summary.
   - Read logs with `ci_logs`.
   - If the failure is clearly an external flake unrelated to the diff, use `ci_rerun` once.
   - Otherwise fix locally, commit (never force-push), verify under `crucible verify <run-dir> -- <verify-command>`, push, and record `crucible record-ci <run-dir> --status failed`. Wait for the next watch wake.
3. **Once required checks are green on `HEAD` and no unresolved blocking bot comments remain:**
   - Record CI green:
     ```sh
     crucible record-ci <run-dir> --status green
     ```
   - If `contract.pr.markReadyOnGreen` is true:
     ```sh
     crucible gate <run-dir> pr-ready
     ```
     Then call `pull_request_update` with `ready: true` (and `requestReviewers: contract.pr.reviewers` if non-empty).
   - Transition to ongoing watch:
     ```sh
     crucible gate <run-dir> pr-watch
     ```

---

## Phase 6: Autonomous PR Watch

Stay parked on `watch_pull_request` (do **not** re-call `watch_pull_request` on each wake; the watch persists).

When woken by new comments, reviews, failing checks, or merge conflicts:

### 1. Inspect fresh state
Read the PR (`pull_request_read` with `checks`, `threads`, `comments`). Skip comments already answered.

### 2. Triage every open item against the current code and `spec.md`

- **Clear bug, test gap, or mechanical fix:**
  1. Check/consume budget: `crucible budget <run-dir> watch --consume` (escalate immediately if exhausted).
  2. Fix minimally, commit, run `crucible verify <run-dir> -- <verify-command>`, push (never force-push).
  3. Reply to the comment/thread via `pull_request_respond` naming the commit SHA and what changed.
- **False positive, already handled, or contradicts locked `spec.md`:**
  1. Reply via `pull_request_respond` with concrete evidence (file/line, test, or constraint). No code edit.
- **Merge conflict with base:**
  - If `contract.pr.autoMergeCleanBase` is true and merging `origin/<base>` resolves cleanly, merge (never force-push), run `crucible verify`, consume watch budget, and push.
  - If the conflict is non-trivial or semantic, run `crucible pause` and escalate to the user.
- **Product/scope change, architectural disagreement, or repeated back-and-forth on the same thread:**
  - Do **not** argue in a loop or silently change product behavior.
  - Run `crucible pause <run-dir> --reason "..."` and present the user a concise 5-line decision brief with the PR link and thread summary.

### 3. Tone, threads & hard stop

- If `contract.hooks.commentVoiceSkill` is configured, draft replies in that voice; otherwise be direct, respectful, and evidence-first (lead with the conclusion, cite code, no fluff).
- Respect `contract.pr.resolveHumanThreads` (default `false`: reply clearly and let human reviewers resolve their own threads).
- **Never merge the PR.** When the watch wakes on merge or close by a human, run `crucible gate <run-dir> done` and finish cleanly.
