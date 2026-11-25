def check_state:
  [.statusCheckRollup[]? | (.conclusion // .state // "")] as $c
  | if ($c | length) == 0 then "none"
    elif ($c | any(. == "FAILURE" or . == "ERROR" or . == "TIMED_OUT" or . == "CANCELLED" or . == "ACTION_REQUIRED")) then "failing"
    elif ($c | any(. == "PENDING" or . == "QUEUED" or . == "IN_PROGRESS" or . == "")) then "pending"
    else "green"
    end;

def failing_count:
  [.statusCheckRollup[]?
   | (.conclusion // .state // "")
   | select(. == "FAILURE" or . == "ERROR" or . == "TIMED_OUT" or . == "CANCELLED" or . == "ACTION_REQUIRED")
  ] | length;

def last_review($me):
  [.reviews[]? | select(.author.login == $me and .submittedAt != null)]
  | sort_by(.submittedAt) | last;

def rereview($me):
  last_review($me) as $r
  | if $r == null then false
    else
      ($r.submittedAt | fromdateiso8601) as $t
      | (([.commits[]? | select(.committedDate != null) | .committedDate | fromdateiso8601] | max // 0) > ($t + 60))
        or ([.comments[]?
             | select(.author.login != $me and .createdAt != null)
             | (.createdAt | fromdateiso8601)
             | select(. > ($t + 60))
            ] | length > 0)
    end;

def authored_reason:
  if .reviewDecision == "CHANGES_REQUESTED" then "changes requested"
  elif (.mergeable == "CONFLICTING" or .mergeStateStatus == "DIRTY") then "merge conflict"
  elif check_state == "failing" then "checks failing (\(failing_count))"
  elif (.reviewDecision == "APPROVED"
        and (check_state == "green" or check_state == "none")
        and .mergeable != "CONFLICTING") then "ready to merge"
  else null
  end;

def flagged($f): (.flags | index($f)) != null;

def bucket($me):
  if flagged("review") then "Review requested"
  elif flagged("authored") and (authored_reason != null) then "Your PRs"
  elif flagged("assigned") then "Assigned"
  elif flagged("mentions") then "Mentions"
  elif flagged("reviewed") and rereview($me) then "Re-review"
  else null
  end;

def repo:
  .url | capture("^https?://[^/]+/(?<r>[^/]+/[^/]+)/pull/").r;

def safe_title:
  .title | gsub("\\["; "\\[") | gsub("\\]"; "\\]");

def ago:
  (now - (.updatedAt | fromdateiso8601)) as $s
  | if $s < 60 then "just now"
    elif $s < 3600 then "\($s / 60 | floor)m ago"
    elif $s < 86400 then "\($s / 3600 | floor)h ago"
    else "\($s / 86400 | floor)d ago"
    end;

def detail:
  if .bucket == "Review requested" then "review requested"
  elif .bucket == "Your PRs" then .reason
  elif .bucket == "Assigned" then "assigned to you"
  elif .bucket == "Mentions" then "mentioned you"
  else "new activity since your review"
  end;

def bucket_rank:
  if .bucket == "Review requested" then 1
  elif .bucket == "Your PRs" then 2
  elif .bucket == "Assigned" then 3
  elif .bucket == "Mentions" then 4
  else 5
  end;

def reason_rank:
  if .reason == "changes requested" then 1
  elif .reason == "merge conflict" then 2
  elif ((.reason // "") | startswith("checks failing")) then 3
  elif .reason == "ready to merge" then 4
  else 9
  end;

def line:
  "- [\(repo)#\(.number) — \(safe_title)](\(.url)) · @\(.author.login) · \(detail) · \(ago)";

. as $all
| ($all | map(select(.isDraft | not))) as $prs
| ($prs
   | map(. + {
       check: check_state,
       reason: authored_reason,
       rereview: rereview($me),
       bucket: bucket($me)
     })
   | map(select(.bucket != null))
   | sort_by(bucket_rank, reason_rank, .updatedAt)
  ) as $rows
| if ($rows | length) == 0 then
    "Nothing needs your attention."
  else
    "**\($rows | length) PR\(if ($rows | length) == 1 then " needs" else "s need" end) attention.**\n\n"
    + (
        ["Review requested", "Your PRs", "Assigned", "Mentions", "Re-review"]
        | map(. as $title
            | [$rows[] | select(.bucket == $title)] as $items
            | if ($items | length) == 0 then empty
              else "## \($title)\n\n" + ($items | map(line) | join("\n")) + "\n"
              end)
        | join("\n")
      )
  end
