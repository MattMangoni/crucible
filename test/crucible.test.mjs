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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crucible-test-"));
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
