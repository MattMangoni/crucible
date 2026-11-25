# PR Attention (Read-Only GitHub Triage)

Find every open, non-draft pull request across all repositories visible to the authenticated `gh` account that is currently waiting on you, grouped by urgency.

This check is strictly **read-only**: never comment, approve, merge, or push.

## Run it

```sh
crucible attention
```

If `gh` or `jq` is missing, or `gh` is not authenticated, report the exact error and stop—never reconstruct the list from memory.

## Urgency buckets

| Bucket | Why the PR appears |
| --- | --- |
| **Review requested** | Someone requested your review; you are blocking them |
| **Your PRs** | Your own PR has changes requested, a merge conflict, failing checks, or is approved & green (ready to merge) |
| **Assigned** | Assigned to you even without a review request |
| **Mentions** | Someone `@`-mentioned you |
| **Re-review** | You previously reviewed it and new commits or comments arrived since |

Each PR appears once in its highest-priority bucket. Draft PRs and authored PRs simply waiting on others are excluded.

## Reporting

- Relay the script's Markdown report mostly as-is, preserving all links.
- Add one line at the top naming the **single best place to start** and why (e.g., the review request blocking a teammate or the approved PR ready to merge).
- If nothing needs attention, state that plainly without padding.
- If the user filtered to one repo or org, keep only matching lines (the underlying query stays global).
- Only run `gh pr view <url> --json title,body,reviews,comments,statusCheckRollup` when the user asks for detail on a specific PR.
