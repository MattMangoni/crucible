import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "./config.mjs";
import {
  expandHome,
  getGitSnapshot,
  getStateRoot,
  readJsonIfExists,
  repoKey,
  sanitizeSlug,
  tryGitTopLevel,
  writeJsonAtomic,
} from "./paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_SPEC = path.resolve(__dirname, "..", "templates", "spec.md");

const BUDGET_MAP = {
  council: "councilRounds",
  ci: "ciFixPushes",
  watch: "prWatchPushes",
};

const VALID_PHASES = new Set([
  "grill",
  "implement",
  "tidy",
  "council",
  "pr-open",
  "pr-ready",
  "pr-watch",
  "paused",
  "done",
]);

function loadRun(runDir) {
  const dir = path.resolve(expandHome(runDir));
  const contractPath = path.join(dir, "contract.json");
  const statePath = path.join(dir, "state.json");
  const contract = readJsonIfExists(contractPath);
  const state = readJsonIfExists(statePath);
  if (!contract || !state) {
    throw new Error(`Not a valid crucible run directory: ${dir}`);
  }
  return { dir, contractPath, statePath, contract, state };
}

function resolveWorkdir(contract, explicitRepo) {
  if (explicitRepo) return path.resolve(expandHome(explicitRepo));
  const cwdTop = tryGitTopLevel(process.cwd());
  if (cwdTop) return cwdTop;
  return contract.repo;
}

export function initRun({
  slug,
  repoDir = process.cwd(),
  base = "origin/main",
  branch = "",
  ticket = null,
  markReady = null,
  force = false,
}) {
  const cleanSlug = sanitizeSlug(slug);
  const { repoRoot, config, sources } = resolveConfig(repoDir);
  const runDir = path.join(getStateRoot(), repoKey(repoRoot), cleanSlug);

  if (fs.existsSync(runDir) && !force) {
    throw new Error(`Run already exists at ${runDir} (pass --force to overwrite)`);
  }

  fs.mkdirSync(path.join(runDir, "council"), { recursive: true });

  const resolvedBranch = branch || `feat/${cleanSlug}`;
  if (typeof markReady === "boolean") {
    config.pr.markReadyOnGreen = markReady;
  }

  const now = new Date().toISOString();
  const contract = {
    version: 1,
    slug: cleanSlug,
    repo: repoRoot,
    base,
    branch: resolvedBranch,
    ticket: ticket || null,
    createdAt: now,
    signedAt: null,
    configSources: sources,
    ...config,
  };

  const state = {
    version: 1,
    slug: cleanSlug,
    repo: repoRoot,
    phase: "grill",
    previousPhase: null,
    updatedAt: now,
    verifiedSha: null,
    verifiedClean: false,
    verifiedAt: null,
    tidySha: null,
    tidySummary: null,
    councilPassed: false,
    councilSha: null,
    councilRounds: [],
    prUrl: null,
    prReady: false,
    ciStatus: null,
    ciSha: null,
    pauseReason: null,
    budgetsUsed: {
      councilRounds: 0,
      ciFixPushes: 0,
      prWatchPushes: 0,
    },
  };

  const template = fs.readFileSync(TEMPLATE_SPEC, "utf8");
  const specText = template
    .replace("<title>", cleanSlug)
    .replace("<slug>", cleanSlug)
    .replace("<repo>", repoRoot)
    .replace("<base>", base)
    .replace("<branch>", resolvedBranch)
    .replace("<ticket-url-or-none>", ticket || "none");

  fs.writeFileSync(path.join(runDir, "spec.md"), specText, "utf8");
  fs.writeFileSync(path.join(runDir, "rebuttals.md"), "# Council Rebuttals\n\n", "utf8");
  writeJsonAtomic(path.join(runDir, "contract.json"), contract);
  writeJsonAtomic(path.join(runDir, "state.json"), state);

  return {
    runDir,
    specPath: path.join(runDir, "spec.md"),
    contractPath: path.join(runDir, "contract.json"),
    statePath: path.join(runDir, "state.json"),
    rebuttalsPath: path.join(runDir, "rebuttals.md"),
    contract,
    state,
  };
}

function validateSpecReady(specText) {
  const errors = [];
  if (!specText || specText.trim().length < 80) {
    errors.push("spec.md is empty or too short.");
    return errors;
  }
  const stripped = specText.replace(/<!--[\s\S]*?-->/g, "");
  const goalMatch = stripped.match(/##\s+Problem & Goal\s*\n([\s\S]*?)(?:\n##\s|$)/);
  if (!goalMatch || goalMatch[1].trim().length < 15) {
    errors.push("spec.md is missing content under '## Problem & Goal'.");
  }
  const acMatch = stripped.match(/##\s+Acceptance Criteria\s*\n([\s\S]*?)(?:\n##\s|$)/);
  const acLines = (acMatch?.[1] || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^-\s+\[[ xX]\]\s+\S+/.test(l));
  if (acLines.length === 0) {
    errors.push("spec.md needs at least one concrete checklist item under '## Acceptance Criteria'.");
  }
  return errors;
}

export function signRun(runDir, { base, branch, ticket } = {}) {
  const { dir, contractPath, statePath, contract, state } = loadRun(runDir);
  const specPath = path.join(dir, "spec.md");
  const specText = fs.existsSync(specPath) ? fs.readFileSync(specPath, "utf8") : "";
  const specErrors = validateSpecReady(specText);
  if (specErrors.length > 0) {
    return { ok: false, errors: specErrors };
  }

  const now = new Date().toISOString();
  if (base) contract.base = base;
  if (branch) contract.branch = branch;
  if (ticket !== undefined) contract.ticket = ticket;
  contract.signedAt = now;

  state.previousPhase = state.phase;
  state.phase = "implement";
  state.pauseReason = null;
  state.updatedAt = now;

  if (specText.includes("- **Signed off:** pending")) {
    fs.writeFileSync(specPath, specText.replace("- **Signed off:** pending", `- **Signed off:** ${now}`), "utf8");
  }

  writeJsonAtomic(contractPath, contract);
  writeJsonAtomic(statePath, state);
  return { ok: true, signedAt: now, phase: state.phase, contract };
}

export function recordVerify(runDir, { repoDir, exitCode }) {
  const { statePath, contract, state } = loadRun(runDir);
  const workdir = resolveWorkdir(contract, repoDir);
  const snap = getGitSnapshot(workdir);
  const now = new Date().toISOString();

  if (exitCode !== 0) {
    state.verifiedSha = null;
    state.verifiedClean = false;
    state.verifiedAt = now;
    state.updatedAt = now;
    writeJsonAtomic(statePath, state);
    return { ok: false, exitCode, head: snap.head, clean: snap.clean };
  }

  state.verifiedSha = snap.head;
  state.verifiedClean = snap.clean;
  state.verifiedAt = now;
  state.updatedAt = now;
  writeJsonAtomic(statePath, state);
  return { ok: true, exitCode: 0, head: snap.head, clean: snap.clean };
}

export function recordTidy(runDir, { repoDir, summary = "" } = {}) {
  const { statePath, contract, state } = loadRun(runDir);
  const workdir = resolveWorkdir(contract, repoDir);
  const snap = getGitSnapshot(workdir);
  if (!snap.clean) {
    return {
      ok: false,
      errors: ["Working tree must be clean (commit tidy edits first) before recording tidy."],
    };
  }
  const now = new Date().toISOString();
  state.tidySha = snap.head;
  state.tidySummary = summary || "completed";
  state.updatedAt = now;
  writeJsonAtomic(statePath, state);
  return { ok: true, tidySha: snap.head, tidySummary: state.tidySummary };
}

export function recordCouncil(runDir, { repoDir, round, scores, blockers, notes = null }) {
  const { statePath, contract, state } = loadRun(runDir);
  const workdir = resolveWorkdir(contract, repoDir);
  const snap = getGitSnapshot(workdir);
  const errors = [];

  if (!snap.clean) {
    errors.push("Working tree must be clean when recording a council round.");
  }
  if (!Number.isInteger(blockers) || blockers < 0) {
    errors.push("blockers must be a non-negative integer.");
  }
  if (!scores || typeof scores !== "object" || Array.isArray(scores) || Object.keys(scores).length === 0) {
    errors.push("scores must be a non-empty JSON object mapping member name to numeric score.");
  }
  if (errors.length > 0) return { ok: false, errors };

  const minScore = contract.council.minScore;
  const maxRounds = Math.min(contract.council.maxRounds, contract.budgets.councilRounds);
  const nextRoundNum = Number.isInteger(round) && round > 0 ? round : state.budgetsUsed.councilRounds + 1;

  if (state.budgetsUsed.councilRounds >= maxRounds) {
    const reason = `Council round budget exhausted (${state.budgetsUsed.councilRounds}/${maxRounds}).`;
    state.previousPhase = state.phase;
    state.phase = "paused";
    state.pauseReason = reason;
    state.updatedAt = new Date().toISOString();
    writeJsonAtomic(statePath, state);
    return { ok: false, escalated: true, errors: [reason] };
  }

  const scoreValues = Object.values(scores);
  const allHighEnough = scoreValues.every((v) => typeof v === "number" && Number.isFinite(v) && v >= minScore);
  const passed = blockers === 0 && allHighEnough;
  const now = new Date().toISOString();

  state.budgetsUsed.councilRounds += 1;
  state.councilRounds.push({
    round: nextRoundNum,
    sha: snap.head,
    scores,
    blockers,
    passed,
    notes,
    recordedAt: now,
  });
  state.councilPassed = passed;
  state.councilSha = snap.head;
  state.updatedAt = now;

  const remainingRounds = Math.max(0, maxRounds - state.budgetsUsed.councilRounds);
  let nextAction = passed ? "proceed-to-pr-open" : "fix-and-reverify";

  if (!passed && remainingRounds === 0) {
    nextAction = "escalate-to-user";
    state.previousPhase = state.phase;
    state.phase = "paused";
    state.pauseReason = `Council did not pass after ${maxRounds} rounds (blockers=${blockers}, scores=${JSON.stringify(scores)}).`;
  }

  writeJsonAtomic(statePath, state);
  return {
    ok: true,
    passed,
    round: nextRoundNum,
    sha: snap.head,
    remainingRounds,
    nextAction,
    pauseReason: state.pauseReason,
  };
}

export function checkBudget(runDir, kind, { consume = false } = {}) {
  const field = BUDGET_MAP[kind];
  if (!field) {
    throw new Error(`Unknown budget kind "${kind}". Expected one of: ${Object.keys(BUDGET_MAP).join(", ")}`);
  }
  const { statePath, contract, state } = loadRun(runDir);
  const limit = contract.budgets[field];
  const used = state.budgetsUsed[field] ?? 0;

  if (used >= limit) {
    const reason = `Budget exhausted for ${kind} (${used}/${limit}). Pause and escalate to user.`;
    if (consume) {
      state.previousPhase = state.phase;
      state.phase = "paused";
      state.pauseReason = reason;
      state.updatedAt = new Date().toISOString();
      writeJsonAtomic(statePath, state);
    }
    return { ok: false, escalated: true, kind, used, limit, remaining: 0, reason };
  }

  const nextUsed = consume ? used + 1 : used;
  if (consume) {
    state.budgetsUsed[field] = nextUsed;
    state.updatedAt = new Date().toISOString();
    writeJsonAtomic(statePath, state);
  }
  return {
    ok: true,
    escalated: false,
    kind,
    used: nextUsed,
    limit,
    remaining: Math.max(0, limit - nextUsed),
  };
}

export function recordPr(runDir, { url, ready = null }) {
  const { statePath, state } = loadRun(runDir);
  if (!url) throw new Error("--url is required.");
  state.prUrl = url;
  if (typeof ready === "boolean") state.prReady = ready;
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(statePath, state);
  return { ok: true, prUrl: state.prUrl, prReady: state.prReady };
}

export function recordCi(runDir, { repoDir, status, sha = null }) {
  if (status !== "green" && status !== "failed") {
    throw new Error("--status must be 'green' or 'failed'.");
  }
  const { statePath, contract, state } = loadRun(runDir);
  const workdir = resolveWorkdir(contract, repoDir);
  const snap = getGitSnapshot(workdir);
  state.ciStatus = status;
  state.ciSha = sha || snap.head;
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(statePath, state);
  return { ok: true, ciStatus: state.ciStatus, ciSha: state.ciSha };
}

export function pauseRun(runDir, { reason }) {
  const { statePath, state } = loadRun(runDir);
  state.previousPhase = state.phase === "paused" ? state.previousPhase : state.phase;
  state.phase = "paused";
  state.pauseReason = reason || "Paused for human input.";
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(statePath, state);
  return { ok: true, phase: state.phase, pauseReason: state.pauseReason };
}

export function gatePhase(runDir, targetPhase, { repoDir, overrideCouncil = false } = {}) {
  if (!VALID_PHASES.has(targetPhase) || targetPhase === "grill" || targetPhase === "paused") {
    throw new Error(`Invalid gate target phase: "${targetPhase}"`);
  }
  const { statePath, contract, state } = loadRun(runDir);
  const workdir = resolveWorkdir(contract, repoDir);
  const snap = getGitSnapshot(workdir);
  const errors = [];

  if (!contract.signedAt) {
    errors.push("Contract is not signed yet. Complete grilling and run `crucible sign` first.");
  }

  const requireVerifiedHead = () => {
    if (!snap.clean) errors.push(`Working tree is dirty (${snap.dirtyFiles.length} uncommitted entries).`);
    if (!snap.head) errors.push("Repository has no commits yet.");
    if (state.verifiedSha !== snap.head || !state.verifiedClean) {
      errors.push(
        `Current HEAD (${snap.head || "none"}) has not passed clean verification (verifiedSha=${state.verifiedSha || "none"}, clean=${state.verifiedClean}). Run \`crucible verify\`.`
      );
    }
  };

  if (targetPhase === "tidy") {
    requireVerifiedHead();
  } else if (targetPhase === "council") {
    requireVerifiedHead();
    if (!state.tidySha) {
      errors.push("Tidy pass has not been recorded. Run tidy and `crucible record-tidy` first.");
    }
    const maxRounds = Math.min(contract.council.maxRounds, contract.budgets.councilRounds);
    if (state.budgetsUsed.councilRounds >= maxRounds) {
      errors.push(`Council round budget exhausted (${state.budgetsUsed.councilRounds}/${maxRounds}).`);
    }
  } else if (targetPhase === "pr-open") {
    requireVerifiedHead();
    if (!state.tidySha) {
      errors.push("Tidy pass has not been recorded.");
    }
    if (!overrideCouncil) {
      if (!state.councilPassed) {
        errors.push("Council has not passed yet. Resolve findings and record a passing council round.");
      }
      if (state.councilSha !== snap.head) {
        errors.push(
          `Council passed on ${state.councilSha || "none"}, but HEAD is ${snap.head}. Re-run council on HEAD before opening the PR.`
        );
      }
    }
  } else if (targetPhase === "pr-ready") {
    requireVerifiedHead();
    if (!contract.pr.markReadyOnGreen) {
      errors.push("Contract disables automatic mark-ready (pr.markReadyOnGreen=false).");
    }
    if (!state.prUrl) {
      errors.push("PR URL has not been recorded. Run `crucible record-pr` first.");
    }
    if (state.ciStatus !== "green" || state.ciSha !== snap.head) {
      errors.push(
        `CI is not recorded green on HEAD (${snap.head}) (ciStatus=${state.ciStatus}, ciSha=${state.ciSha}).`
      );
    }
  } else if (targetPhase === "pr-watch") {
    if (!state.prUrl) {
      errors.push("PR URL has not been recorded.");
    }
  } else if (targetPhase === "done") {
    if (!state.prUrl) {
      errors.push("Cannot mark done without a recorded PR URL.");
    }
  }

  if (errors.length > 0) {
    return { ok: false, targetPhase, currentPhase: state.phase, head: snap.head, errors };
  }

  state.previousPhase = state.phase;
  state.phase = targetPhase;
  state.pauseReason = null;
  if (targetPhase === "pr-ready") {
    state.prReady = true;
  }
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(statePath, state);

  return {
    ok: true,
    phase: state.phase,
    head: snap.head,
    prUrl: state.prUrl,
  };
}

export function getStatus(runDir) {
  const { dir, contract, state } = loadRun(runDir);
  return {
    runDir: dir,
    slug: state.slug,
    repo: contract.repo,
    branch: contract.branch,
    base: contract.base,
    phase: state.phase,
    signedAt: contract.signedAt,
    verifiedSha: state.verifiedSha,
    verifiedClean: state.verifiedClean,
    tidySha: state.tidySha,
    councilPassed: state.councilPassed,
    councilSha: state.councilSha,
    councilRounds: state.councilRounds.length,
    prUrl: state.prUrl,
    prReady: state.prReady,
    ciStatus: state.ciStatus,
    ciSha: state.ciSha,
    budgetsUsed: state.budgetsUsed,
    budgetsLimit: contract.budgets,
    pauseReason: state.pauseReason,
    updatedAt: state.updatedAt,
  };
}

export function listRuns() {
  const root = getStateRoot();
  if (!fs.existsSync(root)) return [];
  const results = [];
  for (const repoEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!repoEntry.isDirectory()) continue;
    const repoPath = path.join(root, repoEntry.name);
    for (const runEntry of fs.readdirSync(repoPath, { withFileTypes: true })) {
      if (!runEntry.isDirectory()) continue;
      const runDir = path.join(repoPath, runEntry.name);
      if (fs.existsSync(path.join(runDir, "state.json")) && fs.existsSync(path.join(runDir, "contract.json"))) {
        results.push(getStatus(runDir));
      }
    }
  }
  return results.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
