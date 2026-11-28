# Spec: <title>

- **Run ID:** <slug>
- **Repository:** <repo>
- **Base ref:** <base>
- **Branch:** <branch>
- **Ticket:** <ticket-url-or-none>
- **Signed off:** pending

## Problem & Goal

<!-- One short paragraph stating what problem this solves and what done looks like. -->

## Non-Goals

<!-- Explicit boundaries: what this change MUST NOT touch or invent. -->
-

## Acceptance Criteria

<!-- Concrete, verifiable behaviors. Each item should map to a test or manual check. -->
- [ ]

## Architecture & Reuse

<!-- Where new code lives, existing modules/helpers reused, and any intentional restructuring. -->
-

## Edge Cases & Failure Modes

<!-- Tricky inputs, concurrency, error paths, backwards compatibility, migrations. -->
-

## Verification Plan

<!-- Exact lint, typecheck, and test commands to run under `crucible verify`. -->
-

## Spec Council Notes

<!-- Key blind spots surfaced during the upfront Spec Council (or "skipped — small task"). -->
-

## Autonomy Contract

<!-- Confirmed during grilling; mirrored in contract.json. Hard invariants: never merge, never force-push. -->
- Branch & commits: authorized
- Tidy & multi-model council loop: authorized (max 5 rounds, 3 when signed `--heavy`)
- Open draft PR & fix CI failures: authorized (max 3 CI-fix pushes)
- Mark PR ready when CI is green & council passed: authorized
- Watch PR & handle review comments: authorized (max 5 watch pushes)
- Pause & escalate to user on: product/scope changes, architectural disagreements, non-trivial merge conflicts, or any exhausted budget.
