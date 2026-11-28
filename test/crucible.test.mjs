import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveConfig } from "../lib/config.mjs";
import { acquireLock, releaseLock } from "../lib/lock.mjs";
import {
  checkBudget,
  gatePhase,
  getStatus,
  initRun,
  listRuns,
  recordCi,
  recordCouncil,
  recordCouncilFollowup,
  recordPr,
  recordTidy,
  recordVerify,
  signRun,
} from "../lib/state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "..", "bin", "crucible.mjs");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeTempRepo(root, name = "demo-repo") {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-b", "main"], dir);
  git(["config", "user.name", "Test User"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n", "utf8");
  git(["add", "README.md"], dir);
  git(["commit", "-m", "chore: initial commit"], dir);
  return dir;
}

function fillValidSpec(specPath) {
  const content = `# Spec: add-widget

- **Run ID:** add-widget
- **Repository:** /tmp/demo
- **Base ref:** origin/main
- **Branch:** feat/add-widget
- **Ticket:** none
- **Signed off:** pending

## Problem & Goal

Add a widget endpoint that returns paginated widget items with deterministic ordering.

## Non-Goals

- No UI changes.

## Acceptance Criteria

- [ ] GET /widgets returns sorted items with cursor pagination.
- [ ] Invalid cursor returns HTTP 400.

## Verification Plan

- npm test
`;
  fs.writeFileSync(specPath, content, "utf8");
}

describe("crucible", () => {
  let tmp;
  let origEnv;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "crucible-test-")));
    origEnv = {
      CRUCIBLE_CONFIG: process.env.CRUCIBLE_CONFIG,
      CRUCIBLE_STATE_DIR: process.env.CRUCIBLE_STATE_DIR,
      CRUCIBLE_LOCK_DIR: process.env.CRUCIBLE_LOCK_DIR,
    };
    process.env.CRUCIBLE_CONFIG = path.join(tmp, "config.json");
    process.env.CRUCIBLE_STATE_DIR = path.join(tmp, "state");
    process.env.CRUCIBLE_LOCK_DIR = path.join(tmp, "heavy.lock");
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("merges defaults, matching profiles, and repo config while keeping hard invariants", () => {
    const acmeDir = makeTempRepo(path.join(tmp, "work", "Acme"), "api");
    fs.writeFileSync(
      process.env.CRUCIBLE_CONFIG,
      JSON.stringify({
        defaults: {
          council: { minScore: 8 },
          pr: { neverMerge: false, neverForcePush: false },
        },
        profiles: [
          {
            match: `${path.join(tmp, "work", "Acme")}/*`,
            hooks: { postWorktreeSetup: "/usr/local/bin/setup" },
            pr: { language: "it" },
          },
        ],
      }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(acmeDir, ".crucible.json"),
      JSON.stringify({
        verify: ["pnpm lint", "pnpm test"],
        council: { minScore: 9 },
        pr: { neverMerge: false },
      }),
      "utf8"
    );

    const resolved = resolveConfig(acmeDir);
    assert.equal(resolved.config.council.minScore, 9);
    assert.equal(resolved.config.council.maxRounds, 5);
    assert.equal(resolved.config.budgets.councilRounds, 5);
    assert.equal(resolved.config.hooks.postWorktreeSetup, "/usr/local/bin/setup");
    assert.equal(resolved.config.pr.language, "it");
    assert.deepEqual(resolved.config.verify, ["pnpm lint", "pnpm test"]);
    assert.equal(resolved.config.pr.neverMerge, true);
    assert.equal(resolved.config.pr.neverForcePush, true);
  });

  it("enforces heavy-command lock mutual exclusion and reclaims dead-PID locks", async () => {
    const lockDir = process.env.CRUCIBLE_LOCK_DIR;
    const h1 = await acquireLock({ lockDir, timeoutMs: 2000, pollMs: 20, command: "cmd1" });

    let acquiredSecond = false;
    const p2 = acquireLock({ lockDir, timeoutMs: 2000, pollMs: 20, command: "cmd2" }).then((h) => {
      acquiredSecond = true;
      return h;
    });

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(acquiredSecond, false);

    releaseLock(h1);
    const h2 = await p2;
    assert.equal(acquiredSecond, true);
    releaseLock(h2);

    // Simulate a crashed process leaving a stale lock behind.
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ pid: 999999, hostname: os.hostname(), token: "dead", command: "crashed" }),
      "utf8"
    );
    const h3 = await acquireLock({ lockDir, timeoutMs: 1000, pollMs: 20, command: "cmd3" });
    releaseLock(h3);
    assert.equal(fs.existsSync(lockDir), false);
  });

  it("runs the full happy path and rejects skipped gates or stale SHAs", () => {
    const repo = makeTempRepo(tmp);
    const run = initRun({ slug: "add-widget", repoDir: repo, base: "main", branch: "feat/add-widget" });

    // Cannot sign with unfilled template spec.
    const badSign = signRun(run.runDir);
    assert.equal(badSign.ok, false);

    // Fill spec and sign.
    fillValidSpec(run.specPath);
    const signed = signRun(run.runDir);
    assert.equal(signed.ok, true);
    assert.equal(signed.phase, "implement");

    // Cannot enter tidy before clean verify.
    assert.equal(gatePhase(run.runDir, "tidy", { repoDir: repo }).ok, false);

    // Implement and commit, then verify.
    fs.writeFileSync(path.join(repo, "widget.js"), "export const widget = 1;\n", "utf8");
    git(["add", "widget.js"], repo);
    git(["commit", "-m", "feat: add widget"], repo);

    assert.equal(recordVerify(run.runDir, { repoDir: repo, exitCode: 0 }).ok, true);
    assert.equal(gatePhase(run.runDir, "tidy", { repoDir: repo }).ok, true);

    // Tidy recorded, enter council.
    assert.equal(recordTidy(run.runDir, { repoDir: repo, summary: "clean" }).ok, true);
    assert.equal(gatePhase(run.runDir, "council", { repoDir: repo }).ok, true);

    // Round 1 fails (score 8, 1 blocker) -> pr-open blocked.
    const r1 = recordCouncil(run.runDir, {
      repoDir: repo,
      round: 1,
      scores: { "Claude Opus 5.5": 8, "GPT 6.2 Sol": 9, "Gemini 4 Neon": 8 },
      blockers: 1,
      majors: 0,
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.passed, false);
    assert.equal(gatePhase(run.runDir, "pr-open", { repoDir: repo }).ok, false);

    // Apply fix, verify, Round 2 passes.
    fs.writeFileSync(path.join(repo, "widget.js"), "export const widget = 2;\n", "utf8");
    git(["add", "widget.js"], repo);
    git(["commit", "-m", "fix: address council round 1"], repo);
    assert.equal(recordVerify(run.runDir, { repoDir: repo, exitCode: 0 }).ok, true);

    const r2 = recordCouncil(run.runDir, {
      repoDir: repo,
      round: 2,
      scores: { "Claude Opus 5.5": 9, "GPT 6.2 Sol": 10, "Gemini 4 Neon": 9 },
      blockers: 0,
      majors: 0,
    });
    assert.equal(r2.passed, true);

    // Sneaky unreviewed commit after council must fail pr-open gate.
    fs.writeFileSync(path.join(repo, "widget.js"), "export const widget = 3;\n", "utf8");
    git(["add", "widget.js"], repo);
    git(["commit", "-m", "chore: unreviewed tweak"], repo);
    assert.equal(recordVerify(run.runDir, { repoDir: repo, exitCode: 0 }).ok, true);
    const staleCouncilGate = gatePhase(run.runDir, "pr-open", { repoDir: repo });
    assert.equal(staleCouncilGate.ok, false);
    assert.match(staleCouncilGate.errors[0], /Re-run council on HEAD/);

    // Round 3 passes on HEAD -> pr-open succeeds.
    const r3 = recordCouncil(run.runDir, {
      repoDir: repo,
      round: 3,
      scores: { "Claude Opus 5.5": 9, "GPT 6.2 Sol": 9, "Gemini 4 Neon": 10 },
      blockers: 0,
      majors: 0,
    });
    assert.equal(r3.passed, true);
    assert.equal(gatePhase(run.runDir, "pr-open", { repoDir: repo }).ok, true);

    // pr-ready requires PR URL and green CI on HEAD.
    assert.equal(gatePhase(run.runDir, "pr-ready", { repoDir: repo }).ok, false);
    recordPr(run.runDir, { url: "https://github.com/org/repo/pull/42" });
    assert.equal(gatePhase(run.runDir, "pr-ready", { repoDir: repo }).ok, false);
    recordCi(run.runDir, { repoDir: repo, status: "green" });

    const readyGate = gatePhase(run.runDir, "pr-ready", { repoDir: repo });
    assert.equal(readyGate.ok, true);
    assert.equal(gatePhase(run.runDir, "pr-watch", { repoDir: repo }).ok, true);
    assert.equal(gatePhase(run.runDir, "done", { repoDir: repo }).ok, true);

    const status = getStatus(run.runDir);
    assert.equal(status.phase, "done");
    assert.equal(status.prReady, true);
    assert.equal(listRuns().length, 1);
  });

  it("supports per-member minScore overrides and calibration config, and enforces the 5-round default cap", () => {
    const repo = makeTempRepo(tmp, "calibration-repo");
    fs.writeFileSync(
      process.env.CRUCIBLE_CONFIG,
      JSON.stringify({
        defaults: {
          council: {
            minScore: 9,
            passRule: "scores",
            members: [
              {
                name: "Claude Opus 5.5",
                provider: "claudeAgent",
                model: "claude-opus-5-5",
                minScore: 10,
                calibration: "Be extra skeptical before awarding 10/10.",
              },
              {
                name: "GPT 6.2 Sol",
                provider: "codex",
                model: "gpt-6.2-sol",
                minScore: 8,
                calibration: "Do not deduct below 9 for minor nits.",
              },
              {
                name: "Gemini 4 Neon",
                provider: "antigravity",
                model: "gemini-4-neon",
              },
            ],
          },
        },
      }),
      "utf8"
    );

    const resolved = resolveConfig(repo);
    assert.equal(resolved.config.council.maxRounds, 5);
    assert.equal(resolved.config.budgets.councilRounds, 5);
    assert.equal(resolved.config.council.members[0].minScore, 10);
    assert.equal(resolved.config.council.members[0].calibration, "Be extra skeptical before awarding 10/10.");
    assert.equal(resolved.config.council.members[1].minScore, 8);

    const run = initRun({ slug: "calibration-test", repoDir: repo });

    // Round 1: Opus scores 9 (below its 10 override) -> fails even though GPT 8 meets its 8 override and Gemini 9 meets global 9.
    const r1 = recordCouncil(run.runDir, {
      repoDir: repo,
      round: 1,
      scores: { "Claude Opus 5.5": 9, "GPT 6.2 Sol": 8, "Gemini 4 Neon": 9 },
      blockers: 0,
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.passed, false);
    assert.equal(r1.remainingRounds, 4);
    assert.equal(r1.nextAction, "fix-and-reverify");

    // Round 2: GPT scores 7 (below its 8 override) -> fails.
    const r2 = recordCouncil(run.runDir, {
      repoDir: repo,
      round: 2,
      scores: { "Claude Opus 5.5": 10, "GPT 6.2 Sol": 7, "Gemini 4 Neon": 9 },
      blockers: 0,
    });
    assert.equal(r2.passed, false);
    assert.equal(r2.remainingRounds, 3);

    // Round 3: Gemini scores 8 (below global 9) -> fails.
    const r3 = recordCouncil(run.runDir, {
      repoDir: repo,
      round: 3,
      scores: { "Claude Opus 5.5": 10, "GPT 6.2 Sol": 8, "Gemini 4 Neon": 8 },
      blockers: 0,
    });
    assert.equal(r3.passed, false);
    assert.equal(r3.remainingRounds, 2);

    // Round 4: All meet their respective thresholds (Opus 10, GPT 8, Gemini 9) -> passes.
    const r4 = recordCouncil(run.runDir, {
      repoDir: repo,
      round: 4,
      scores: { "Claude Opus 5.5": 10, "GPT 6.2 Sol": 8, "Gemini 4 Neon": 9 },
      blockers: 0,
    });
    assert.equal(r4.passed, true);
    assert.equal(r4.remainingRounds, 1);
    assert.equal(r4.nextAction, "proceed-to-pr-open");

    // Round 5 (failing) exhausts the 5-round default cap and escalates.
    const r5 = recordCouncil(run.runDir, {
      repoDir: repo,
      round: 5,
      scores: { "Claude Opus 5.5": 9, "GPT 6.2 Sol": 8, "Gemini 4 Neon": 9 },
      blockers: 0,
    });
    assert.equal(r5.passed, false);
    assert.equal(r5.remainingRounds, 0);
    assert.equal(r5.nextAction, "escalate-to-user");
    assert.equal(getStatus(run.runDir).phase, "paused");
  });

  function councilReadyRun(slug, { heavy = false } = {}) {
    const repo = makeTempRepo(tmp, `${slug}-repo`);
    const run = initRun({ slug, repoDir: repo });
    fillValidSpec(run.specPath);
    assert.equal(signRun(run.runDir, { heavy }).ok, true);
    commitAndVerify(repo, run, "v1");
    assert.equal(recordTidy(run.runDir, { repoDir: repo }).ok, true);
    assert.equal(gatePhase(run.runDir, "council", { repoDir: repo }).ok, true);
    return { repo, run };
  }

  function commitAndVerify(repo, run, content) {
    fs.writeFileSync(path.join(repo, "widget.js"), `export const widget = "${content}";\n`, "utf8");
    git(["add", "widget.js"], repo);
    git(["commit", "-m", `fix: ${content}`], repo);
    assert.equal(recordVerify(run.runDir, { repoDir: repo, exitCode: 0 }).ok, true);
  }

  it("defaults to the convergence rule with a calibrated GPT member and a heavy-change round cap", () => {
    const repo = makeTempRepo(tmp, "defaults-repo");
    const { config } = resolveConfig(repo);
    assert.equal(config.council.passRule, "convergence");
    assert.equal(config.council.heavyMaxRounds, 3);
    assert.match(config.council.members.find((m) => m.provider === "codex").calibration, /minor/);

    const { run } = councilReadyRun("heavy", { heavy: true });
    const contract = JSON.parse(fs.readFileSync(run.contractPath, "utf8"));
    assert.equal(contract.council.maxRounds, 3);
    assert.equal(contract.council.heavy, true);
  });

  it("passes a converged round despite one low score, and requires --majors", () => {
    const { repo, run } = councilReadyRun("converge");
    const missing = recordCouncil(run.runDir, {
      repoDir: repo,
      scores: { A: 9, B: 8, C: 9 },
      blockers: 0,
    });
    assert.equal(missing.ok, false);
    assert.match(missing.errors[0], /majors is required/);

    const r1 = recordCouncil(run.runDir, { repoDir: repo, scores: { A: 9, B: 8, C: 9 }, blockers: 0, majors: 1 });
    assert.equal(r1.passed, false);

    commitAndVerify(repo, run, "v2");
    const r2 = recordCouncil(run.runDir, { repoDir: repo, scores: { A: 9, B: 8, C: 10 }, blockers: 0, majors: 0 });
    assert.equal(r2.passed, true);
    assert.equal(r2.medianScore, 9);
    assert.equal(r2.nextAction, "proceed-to-pr-open");
    assert.equal(gatePhase(run.runDir, "pr-open", { repoDir: repo }).ok, true);
  });

  it("rejects a majority of low scores when no fix-hunk majors explain them", () => {
    const { repo, run } = councilReadyRun("majority");
    const r1 = recordCouncil(run.runDir, { repoDir: repo, scores: { A: 8, B: 8, C: 9 }, blockers: 0, majors: 0 });
    assert.equal(r1.passed, false);
  });

  it("closes fix-hunk majors with a verified follow-up instead of another round", () => {
    const { repo, run } = councilReadyRun("followup");
    const early = recordCouncil(run.runDir, {
      repoDir: repo,
      scores: { A: 8, B: 8, C: 8 },
      blockers: 0,
      majors: 0,
      fixMajors: 1,
    });
    assert.equal(early.ok, false);
    assert.match(early.errors[0], /previous round/);

    recordCouncil(run.runDir, { repoDir: repo, scores: { A: 8, B: 7, C: 8 }, blockers: 0, majors: 2 });
    commitAndVerify(repo, run, "v2");
    const r2 = recordCouncil(run.runDir, {
      repoDir: repo,
      scores: { A: 8, B: 8, C: 8 },
      blockers: 0,
      majors: 0,
      fixMajors: 1,
    });
    assert.equal(r2.passed, true);
    assert.equal(r2.nextAction, "apply-followup-fixes");
    const blocked = gatePhase(run.runDir, "pr-open", { repoDir: repo });
    assert.equal(blocked.ok, false);
    assert.match(blocked.errors.join("\n"), /--followup/);

    assert.equal(recordCouncilFollowup(run.runDir, { repoDir: repo }).ok, false);
    commitAndVerify(repo, run, "v3");
    const done = recordCouncilFollowup(run.runDir, { repoDir: repo, notes: "guarded the new branch" });
    assert.equal(done.ok, true);
    assert.equal(recordCouncilFollowup(run.runDir, { repoDir: repo }).ok, false);
    assert.equal(gatePhase(run.runDir, "pr-open", { repoDir: repo }).ok, true);
    const status = getStatus(run.runDir);
    assert.equal(status.councilRounds, 2);
    assert.equal(status.budgetsUsed.councilRounds, 2);
  });

  it("requires a redesign note when the same area fails two rounds running", () => {
    const { repo, run } = councilReadyRun("hotspot");
    const round = (areas) =>
      recordCouncil(run.runDir, { repoDir: repo, scores: { A: 8, B: 8, C: 8 }, blockers: 0, majors: 1, areas });

    assert.deepEqual(round("app/player.tsx,lib/a.ts").hotspots, []);
    commitAndVerify(repo, run, "v2");
    const r2 = round("app/player.tsx");
    assert.deepEqual(r2.hotspots, ["app/player.tsx"]);
    assert.equal(r2.nextAction, "redesign-hotspots");

    commitAndVerify(repo, run, "v3");
    const refused = round("lib/b.ts");
    assert.equal(refused.ok, false);
    assert.match(refused.errors[0], /redesign/);

    fs.writeFileSync(r2.redesignNote, "Player bar: replaced the overlay with a docked strip.\n", "utf8");
    const r3 = round("lib/b.ts");
    assert.equal(r3.ok, true);
    assert.deepEqual(r3.hotspots, []);
    assert.equal(getStatus(run.runDir).pendingRedesign, null);
  });

  it("keeps the scores rule for contracts signed before passRule existed", () => {
    const { repo, run } = councilReadyRun("legacy");
    const contract = JSON.parse(fs.readFileSync(run.contractPath, "utf8"));
    delete contract.council.passRule;
    fs.writeFileSync(run.contractPath, JSON.stringify(contract), "utf8");
    const r1 = recordCouncil(run.runDir, { repoDir: repo, scores: { A: 9, B: 8, C: 9 }, blockers: 0 });
    assert.equal(r1.ok, true);
    assert.equal(r1.passed, false);
    assert.equal(r1.passRule, "scores");
  });

  it("enforces push budgets and pauses when exhausted", () => {
    const repo = makeTempRepo(tmp);
    const run = initRun({ slug: "budget-test", repoDir: repo });

    // Default ciFixPushes is 3.
    assert.equal(checkBudget(run.runDir, "ci", { consume: true }).ok, true);
    assert.equal(checkBudget(run.runDir, "ci", { consume: true }).ok, true);
    assert.equal(checkBudget(run.runDir, "ci", { consume: true }).ok, true);

    const exhausted = checkBudget(run.runDir, "ci", { consume: true });
    assert.equal(exhausted.ok, false);
    assert.equal(exhausted.escalated, true);
    assert.equal(getStatus(run.runDir).phase, "paused");
  });

  it("works end-to-end through the CLI binary", () => {
    const repo = makeTempRepo(tmp, "cli-repo");
    const initOut = JSON.parse(
      execFileSync(process.execPath, [CLI, "init", "cli-smoke", "--repo", repo], { encoding: "utf8" })
    );
    assert.ok(fs.existsSync(initOut.specPath));

    const verifyOut = JSON.parse(
      execFileSync(
        process.execPath,
        [CLI, "verify", initOut.runDir, "--repo", repo, "--", process.execPath, "-e", "process.exit(0)"],
        { encoding: "utf8" }
      )
    );
    assert.equal(verifyOut.ok, true);
    assert.equal(verifyOut.clean, true);

    const statusOut = JSON.parse(execFileSync(process.execPath, [CLI, "status", "--all"], { encoding: "utf8" }));
    assert.equal(statusOut.runs.length, 1);
    assert.equal(statusOut.runs[0].slug, "cli-smoke");
  });

  it("formats PR attention buckets via report.jq and excludes drafts", () => {
    const jqPath = path.resolve(__dirname, "..", "skills", "crucible", "scripts", "report.jq");
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const sample = [
      {
        number: 10,
        title: "Draft WIP",
        url: "https://github.com/acme/app/pull/10",
        isDraft: true,
        reviewDecision: "",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [],
        updatedAt: nowIso,
        createdAt: nowIso,
        author: { login: "alice" },
        reviews: [],
        comments: [],
        commits: [],
        flags: ["review"],
      },
      {
        number: 11,
        title: "Fix auth",
        url: "https://github.com/acme/app/pull/11",
        isDraft: false,
        reviewDecision: "",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [],
        updatedAt: nowIso,
        createdAt: nowIso,
        author: { login: "bob" },
        reviews: [],
        comments: [],
        commits: [],
        flags: ["review"],
      },
      {
        number: 12,
        title: "Add billing",
        url: "https://github.com/acme/app/pull/12",
        isDraft: false,
        reviewDecision: "CHANGES_REQUESTED",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: [],
        updatedAt: nowIso,
        createdAt: nowIso,
        author: { login: "me" },
        reviews: [],
        comments: [],
        commits: [],
        flags: ["authored"],
      },
    ];
    const out = execFileSync("jq", ["-rs", "--arg", "me", "me", "-f", jqPath], {
      input: sample.map((x) => JSON.stringify(x)).join("\n"),
      encoding: "utf8",
    });
    assert.match(out, /\*\*2 PRs need attention\.\*\*/);
    assert.match(out, /## Review requested/);
    assert.match(out, /acme\/app#11/);
    assert.match(out, /## Your PRs/);
    assert.match(out, /acme\/app#12/);
    assert.doesNotMatch(out, /Draft WIP/);
  });
});
