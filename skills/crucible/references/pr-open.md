# Phase 5: PR Open, CI Green & Mark Ready

Handles opening a pull request cleanly, monitoring CI to green, and marking the PR ready for review (never merging).

## 1. Pre-flight gates

Before opening a PR during a Crucible run, enforce the deterministic gate first:

```sh
crucible gate <run-dir> pr-open
```

Verify every pre-flight condition (stop and report the first failure; never fix a gate by rewriting published history):
1. Working tree is clean and every commit is pushed.
2. Branch contains the latest target base (`git fetch origin` and `git merge-base --is-ancestor <base> HEAD`).
   - If behind during an autonomous run and `contract.pr.autoMergeCleanBase` is `true`, merge `<base>` cleanly (never force-push), re-verify with `crucible verify`, and re-run council if the merge touched non-trivial code. If conflicts are non-trivial, run `crucible pause` and escalate.
   - Outside a signed contract, ask the user before merging or rebasing base.
3. Lint, typecheck, and tests passed on `HEAD`.
4. Tidy and multi-model council review passed on `HEAD` with every valid finding fixed.

## 2. Optional hooks

- If `contract.hooks.prePrOpen` is configured, run it under `crucible lock`.
- If `contract.hooks.prePrOpenSkill` is configured, follow its repo-specific pre-PR steps and formatting—while still honoring the signed `contract.json` rules (`markReadyOnGreen`, `reviewers`, `neverMerge`, `neverForcePush`).

## 3. Match repository conventions & open a draft PR

1. Inspect the last 5 merged PRs (`gh pr list --state merged -L 5`) to match the repository's title style, conventions, and language (unless overridden by `contract.pr.language`).
2. Identify the base branch (`contract.base`, default branch, epic branch, or previous branch in a stack).
3. Open a **draft PR** against `<base>` using `pull_request_create` (`draft: true`, or `gh pr create --draft --base <base>`):
   - **Title:** concise, imperative, matching repo style (<= 70 characters).
   - **Body, in this order:**
     1. **What and why:** plain language explaining what changed, why it matters, and any intentional divergence from the ticket/spec.
     2. **How to test:** the simplest concrete steps (dev command, ports/URLs, what to click or verify).
     3. **Stack note** (if stacked on another PR): explicitly name the parent PR/branch.
     4. **Issue/ticket link** (when `contract.ticket` is set).
     5. **Council review table** (from Phase 4):
        ```markdown
        ## Council review

        Rounds: 2

        | Member | Round 1 | Round 2 |
        | --- | --- | --- |
        | Claude Opus 5.5 | 8/10 | 9/10 |
        | GPT 6.2 Sol | 9/10 | 10/10 |
        | Gemini 4 Neon | 8/10 | 9/10 |
        ```
4. Link the PR to the thread (`link_pull_request` if not already linked by `pull_request_create`) and record it in Crucible state:
   ```sh
   crucible record-pr <run-dir> --url <pr-url>
   ```
5. If `contract.hooks.postPrOpen` is configured, run it.

## 4. Watch CI until green, then mark ready

1. Start watching the PR via `watch_pull_request` (`until: "merged"`, since Phase 6 keeps handling comments and CI until a human merges or closes it) and end your turn to wait for check results.
2. **If CI fails:**
   - Consume the CI-fix budget first: `crucible budget <run-dir> ci --consume`. If it exits non-zero, pause and escalate with the failing check summary.
   - Read logs via `ci_logs`.
   - If the failure is clearly an external flake unrelated to the diff, retry once via `ci_rerun`.
   - Otherwise fix locally, commit (never force-push), re-verify under `crucible verify <run-dir> -- <verify-command>`, push, and record `crucible record-ci <run-dir> --status failed`. Wait for the next watch wake.
3. **Once required checks pass on `HEAD` and no unresolved blocking bot comments remain:**
   - Record CI green:
     ```sh
     crucible record-ci <run-dir> --status green
     ```
   - If `contract.pr.markReadyOnGreen` is `true` (default in Crucible runs):
     ```sh
     crucible gate <run-dir> pr-ready
     ```
     Then mark the PR ready via `pull_request_update` (`ready: true`, and `requestReviewers: contract.pr.reviewers` if non-empty).
   - Transition to ongoing comment watching:
     ```sh
     crucible gate <run-dir> pr-watch
     ```
   - Immediately proceed to [pr-comments.md](pr-comments.md) to handle any initial bot or reviewer comments.

## Hard guardrails

- **Never merge a PR.**
- **Never force-push.**
- Outside a signed Crucible contract, never mark a PR ready or request reviewers unless the user explicitly asks.
