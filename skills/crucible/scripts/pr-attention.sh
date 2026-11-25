#!/bin/sh
# List open GitHub pull requests that need the authenticated user's attention.
# Read-only: this script never comments, approves, merges or pushes.
set -eu

dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

for c in gh jq; do
  command -v "$c" >/dev/null 2>&1 || {
    echo "error: $c is not installed" >&2
    exit 1
  }
done

gh auth status >/dev/null 2>&1 || {
  echo "error: gh is not authenticated (run: gh auth login)" >&2
  exit 1
}

me=$(gh api user --jq .login)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/crucible-pr-attention.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

search() {
  out=$1
  shift
  if ! gh search prs --state=open --limit 100 "$@" --json url -q '.[].url' >"$tmp/$out"; then
    echo "warning: search failed: gh search prs $*" >&2
    : >"$tmp/$out"
  fi
}

search review --review-requested=@me
search assigned --assignee=@me
search authored --author=@me
search mentions --mentions=@me
search reviewed --reviewed-by=@me

cat "$tmp/review" "$tmp/assigned" "$tmp/authored" "$tmp/mentions" "$tmp/reviewed" |
  sed '/^$/d' | sort -u >"$tmp/urls"

: >"$tmp/details"
while IFS= read -r url; do
  [ -n "$url" ] || continue
  if ! gh pr view "$url" \
    --json number,title,url,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,updatedAt,createdAt,author,reviewRequests,assignees,reviews,comments,commits \
    >"$tmp/raw" 2>/dev/null; then
    echo "warning: could not read $url" >&2
    continue
  fi

  flags=""
  for f in review assigned authored mentions reviewed; do
    grep -qxF "$url" "$tmp/$f" && flags="$flags $f"
  done

  jq -c --arg flags "$flags" '. + {flags: ($flags | split(" ") | map(select(length > 0)))}' \
    "$tmp/raw" >>"$tmp/details"
done <"$tmp/urls"

jq -rs --arg me "$me" -f "$dir/report.jq" "$tmp/details"
