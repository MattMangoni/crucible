# Crucible

An autonomous software factory for **T3 Code** (and multi-model coding agents): **heavy upfront grilling** to lock a concrete spec, followed by an **autonomous, gate-enforced pipeline** through implementation, DRY/KISS tidying, bounded multi-model council review, PR creation, CI fixing, marking ready, and ongoing PR comment watching—**everything except merging**.

Built to run on top of your existing subscriptions (Claude, Codex, Antigravity) through T3 Code's native harnesses—no custom LLM wrapper to maintain, zero runtime dependencies, and zero files committed into target repositories.

## How it works

```text
1. GRILL         Interactive deep-dive + optional 1-round Spec Council
                 → writes spec.md + signed contract.json
                 → user says "GO" (last planned human touch)
                       │
                       ▼
2. IMPLEMENT     Isolated worktree · build strictly to spec.md
                 → `crucible verify` (runs tests/lint under machine-wide lock)
                       │
                       ▼
3. TIDY          2-agent read-only DRY/KISS cleanup pass → apply → verify
                       │
                       ▼
4. COUNCIL       Bounded hub-and-spoke multi-model review (default max 5 rounds)
                 → Round 1 exhaustive audit; Round 2+ delta convergence review
                 → severity-anchored rubric + adversarial check before scoring >= 9
                 → coordinator judges findings against code + spec.md
                 → applies valid fixes + logs rejections in rebuttals.md
                 → exits on 0 blockers & every member >= minScore (default 9/10)
                       │
                       ▼
5. PR & CI       `crucible gate pr-open` → draft PR + council score table
                 → auto-fix CI failures (capped) → mark PR Ready when green
                       │
                       ▼
6. PR WATCH      Watches PR for comments, reviews, CI failures, clean conflicts
                 → auto-fixes bugs, rebuts false positives, escalates design calls
                 → NEVER merges, NEVER force-pushes
```

## Key design choices

- **Deterministic guardrails in code (`crucible` CLI):** An LLM shouldn't self-certify that it ran tests or finished review. `crucible gate` checks actual git state (`HEAD` SHA, clean working tree, verified SHA, tidy record, passing council SHA, CI status) before advancing phases.
- **Machine-wide heavy-command lock (`crucible lock` / `crucible verify`):** Parallel worktree runs share an atomic lock (with stale-PID recovery) so concurrent test suites and builds never OOM your machine.
- **Bounded hub-and-spoke council (no agent-chat drift):** Reviewers stay read-only; one coordinator owns edits and writes `rebuttals.md` between rounds. Hard round and push budgets prevent infinite loops.
- **Zero repo pollution:** All run state lives under `~/.local/state/crucible/runs/<repo>/<slug>/`, never inside your repositories.
- **Org/repo agnostic with private hooks:** Keep company-specific workflows (custom worktree setup, staging merges, PR templates, commit language) in your private `~/.config/crucible/config.json` path profiles or repo-local `.crucible.json`.

## Quickstart

Requires **Node.js >= 20**.

```sh
git clone https://github.com/MattMangoni/crucible.git
cd crucible
sh install.sh
```

`install.sh` symlinks:
- `bin/crucible.mjs` → `~/.local/bin/crucible`
- `skills/crucible` → `~/.agents/skills/crucible` and `~/.claude/skills/crucible`

Run tests:

```sh
npm test
```

### Usage in T3 Code

- **Single task:** `"Run /crucible on <brief or issue URL>"`
- **Parallel batch:** `"Run /crucible batch on these 3 tickets: ..."` — grills all tasks up front, then fans out isolated worktree threads via `t3_thread_launch` while sharing the heavy-command lock.

## Configuration & org hooks

Create an optional `~/.config/crucible/config.json` (and/or `.crucible.json` inside any repo):

```json
{
  "defaults": {
    "council": {
      "members": [
        { "name": "Claude Opus 5.5", "provider": "claudeAgent", "model": "claude-opus-5-5", "options": { "effort": "high" } },
        { "name": "GPT 6.2 Sol", "provider": "codex", "model": "gpt-6.2-sol", "options": { "reasoningEffort": "high" } },
        { "name": "Gemini 4 Neon", "provider": "antigravity", "model": "gemini-4-neon", "options": { "thought_level": "high" } }
      ],
      "minScore": 9,
      "maxRounds": 5,
      "specCouncil": "auto"
    },
    "budgets": {
      "councilRounds": 5,
      "ciFixPushes": 3,
      "prWatchPushes": 5
    },
    "pr": {
      "markReadyOnGreen": true,
      "autoMergeCleanBase": true,
      "resolveHumanThreads": false
    }
  },
  "profiles": [
    {
      "match": "~/Code/Acme/*",
      "hooks": {
        "postWorktreeSetup": "~/.local/bin/acme-worktree-setup",
        "workflowSkill": "acme-workflow",
        "prePrOpenSkill": "acme-pr-open",
        "commentVoiceSkill": "acme-pr-voice"
      },
      "pr": {
        "language": "en"
      }
    }
  ]
}
```

Inspect the resolved config for any repo:

```sh
crucible config --repo /path/to/repo
```

Each entry in `council.members` also accepts two optional calibration fields:
- `minScore` (number, `1–10`) — overrides `council.minScore` for that member only.
- `calibration` (string) — extra review guidance appended verbatim to that member's council prompt.

## CLI reference

| Command | Purpose |
| --- | --- |
| `crucible config [--repo <dir>]` | Print merged defaults + matching profiles + `.crucible.json` |
| `crucible init <slug> [opts]` | Create run directory with `spec.md`, `contract.json`, `state.json`, `rebuttals.md` |
| `crucible sign <run-dir>` | Validate `spec.md`, lock `contract.json`, advance `grill` → `implement` |
| `crucible lock -- <cmd...>` | Run any heavy command under the machine-wide mutex |
| `crucible verify <run-dir> -- <cmd...>` | Run verification under the lock and stamp `verifiedSha` on `HEAD` |
| `crucible record-tidy <run-dir>` | Record completed tidy pass on clean `HEAD` |
| `crucible record-council <run-dir> --scores <json> --blockers <n>` | Record a council round, evaluate pass/fail, enforce round budget |
| `crucible record-pr <run-dir> --url <url>` | Record opened PR URL |
| `crucible record-ci <run-dir> --status <green\|failed>` | Record CI outcome for `HEAD` |
| `crucible budget <run-dir> <council\|ci\|watch> [--consume]` | Check or consume loop budget; pauses run and exits non-zero when exhausted |
| `crucible gate <run-dir> <phase>` | Enforce deterministic phase invariants before advancing |
| `crucible pause <run-dir> --reason <text>` | Pause run for human decision |
| `crucible status [<run-dir>] [--all]` | Inspect one run or list all runs across repos |
| `crucible attention` | Read-only triage of open GitHub PRs waiting on you (requires `gh` + `jq`) |

## Built-in PR playbooks

Crucible bundles standalone, repo-agnostic PR handling playbooks under `skills/crucible/references/` (all overridable via `hooks` in `~/.config/crucible/config.json`):

- **`pr-open.md`** — Pre-flight gates, matching repository title/language style, draft PR format with council review table, CI auto-fix loop, and marking ready on green.
- **`pr-comments.md`** — Collecting open comments and unresolved GraphQL review threads, judging every finding against current code, fixing or rebutting with evidence, and watching via `watch_pull_request`.
- **`comment-voice.md`** — Direct, warm, evidence-first PR comment voice with author/reviewer role checks, disclosure box for substantive agent-augmented reviews, and pre-post secret checks.
- **`pr-attention.md`** (+ `crucible attention`) — Read-only GitHub PR inbox grouped by urgency (`Review requested`, `Your PRs`, `Assigned`, `Mentions`, `Re-review`), ignoring drafts.

## Hard invariants

No config, profile, or contract can override these:
- `pr.neverMerge = true` — Crucible never merges pull requests.
- `pr.neverForcePush = true` — Crucible never force-pushes or rewrites published history.

## License

MIT
