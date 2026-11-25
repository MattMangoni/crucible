# Phase 1: Heavy Grill & Spec Council

The goal of Phase 1 is to eliminate ambiguity **before** autonomous execution begins so Phases 2–6 require zero routine questions.

## 1. Load context before asking questions

1. Fetch the target base ref (`git fetch origin <base>` when a remote exists) without touching dirty local work.
2. Read the repo's `AGENTS.md` / `CLAUDE.md`, `crucible config --repo <repo-dir>`, and any referenced issue/ticket **plus all comments and linked issues**.
3. Explore the relevant existing files so you never ask questions the codebase already answers.

## 2. Pressure-test & grill relentlessly

Walk every branch of the design tree with the user, one focused cluster of questions at a time, giving your recommended answer for each decision:

- **Problem & non-goals:** What exact problem does this solve, and what must stay strictly out of scope?
- **Behavior & edge cases:** Empty states, invalid inputs, auth/permissions, concurrency/races, backwards compatibility, migrations, rollback risk.
- **Architecture & reuse:** Which existing modules/helpers will be reused? Where does new code live? If the change fights the current structure, propose the clean refactor now rather than patching around it.
- **Verification:** What exact lint, typecheck, and test commands prove the change works? Are new unit/integration tests required?
- **PR & autonomy settings:** Confirm base branch, branch name, draft-then-ready behavior (`markReadyOnGreen`), reviewers (if any), and any repo-specific hooks.

Challenge weak assumptions directly. If a simpler approach achieves the same goal, propose it.

## 3. Draft `spec.md` and run the Spec Council

Initialize the run if not already done:

```sh
crucible init <slug> --repo <repo-dir> --base <base> --branch <branch> [--ticket <url>]
```

Write the complete, concrete spec into `<run-dir>/spec.md` (every acceptance criterion as a verifiable `- [ ] ...` checklist item).

### Upfront Spec Council

Check `contract.council.specCouncil`:
- `"never"` → skip.
- `"auto"` → run for medium/large or architecturally sensitive tasks; skip for small, mechanical changes.
- `"always"` → always run.

When running the Spec Council:
1. Launch read-only delegates in parallel (one per model in `contract.council.members` via T3 Code `delegate_task`, after calling `orchestrator_capabilities` once).
2. Give each delegate `<run-dir>/spec.md` and the key file paths it touches. Ask for **only** concrete blind spots: missing edge cases, broken assumptions against the codebase, scope risks, or simpler designs. No fluff.
3. Synthesize only the substantive findings, present them to the user, resolve any open decisions, and fold the answers into `<run-dir>/spec.md` under `## Spec Council Notes`.

## 4. Sign-off ("GO")

Present a crisp recap:
- Branch & base
- Scope summary + non-goals
- Verification commands
- Autonomy contract (including hard invariants: never merge, never force-push, budget caps)

Do **not** edit repo files or leave Phase 1 until the user explicitly confirms (**GO**). Then run:

```sh
crucible sign <run-dir> --base <base> --branch <branch>
```

If `crucible sign` rejects `spec.md`, fill in the missing sections before proceeding.
