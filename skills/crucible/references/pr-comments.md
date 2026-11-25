# Phase 6: Autonomous PR Comment Handling & Watching

Works through every open pull request comment, review thread, CI failure, or merge conflict—judging each finding against the actual code and locked spec, fixing what holds up, rebutting what doesn't, and watching for new activity until a human merges or closes the PR.

## 1. Pin the PR & inspect open items

1. Identify the PR (from `<run-dir>/state.json`, user argument, or `gh pr view --json number,url,headRefName`). Work in a checkout of its head branch, up to date with `origin`.
2. Collect everything still open:
   - In T3 Code: `pull_request_read` with `include: ["checks", "threads", "comments"]`.
   - Via CLI fallback: conversation comments/reviews (`gh pr view --comments`) and unresolved review threads (`gh api graphql` filtering `reviewThreads` where `isResolved: false`).
   - Skip comments you already answered.

## 2. Triage every finding against current code & `spec.md`

Check every comment directly against the current code—**never** trust a reviewer's or bot's summary alone:

- **Holds up (real bug, test gap, or clear mechanical fix):**
  1. During a Crucible run, consume watch budget first: `crucible budget <run-dir> watch --consume`. If exhausted, stop and escalate to the user.
  2. Fix minimally and cleanly, commit using the repo's commit style, run verification (`crucible verify <run-dir> -- <verify-command>` or repo lint/tests), and push (**never force-push**).
  3. Reply to the comment/thread naming the commit SHA and concisely stating what changed.
- **Does not hold up (false positive, already handled, or contradicts locked `spec.md`):**
  1. Reply with concrete evidence: exact file/line, test, or architectural/spec constraint. Do not edit code just to appease a false positive.
- **Merge conflict with base:**
  - If `contract.pr.autoMergeCleanBase` is `true` and merging `origin/<base>` resolves cleanly, merge (never force-push), consume watch budget, run `crucible verify`, and push.
  - If the conflict is non-trivial or semantic, run `crucible pause` and escalate to the user.
- **Cannot be fixed safely in this PR (product/scope change, architectural disagreement, or repeated back-and-forth on the same thread):**
  - **Never** defer a real finding with a `TODO` comment or a silent follow-up ticket.
  - Do not argue in circles. Run `crucible pause <run-dir> --reason "..."` and escalate to the user with a crisp 5-line decision brief and the PR link.

## 3. Reply voice & rules

- Reply to **every** comment, bots included.
- Draft replies using `contract.hooks.commentVoiceSkill` if configured; otherwise follow the built-in default in [comment-voice.md](comment-voice.md).
- After pushing fixes, re-check lint and tests for everything touched under the repo's rules.

## 4. Keep listening

- In T3 Code: keep `watch_pull_request` active on the PR (do **not** re-call `watch_pull_request` on each wake—an active watch persists across pushes). On each new comment, review, check failure, or conflict, repeat from Step 1.
- When a human merges or closes the PR, run `crucible gate <run-dir> done` and finish cleanly.

## Hard guardrails

- **Never merge the PR.**
- **Never force-push.**
- Respect `contract.pr.resolveHumanThreads` (default `false`: leave human review threads open for the reviewer to resolve after reading your reply).
- Outside a signed Crucible contract, never resolve threads, mark ready, or merge unless the user explicitly asks.
