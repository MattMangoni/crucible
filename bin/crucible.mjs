#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../lib/config.mjs";
import { runWithLock } from "../lib/lock.mjs";
import {
  checkBudget,
  gatePhase,
  getStatus,
  initRun,
  listRuns,
  pauseRun,
  recordCi,
  recordCouncil,
  recordCouncilFollowup,
  recordPr,
  recordTidy,
  recordVerify,
  signRun,
} from "../lib/state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ATTENTION_SCRIPT = path.resolve(__dirname, "..", "skills", "crucible", "scripts", "pr-attention.sh");

const USAGE = `crucible — deterministic state machine, lock, and gates for autonomous software runs

Usage:
  crucible config [--repo <dir>]
  crucible init <slug> [--repo <dir>] [--base <ref>] [--branch <name>] [--ticket <url>] [--mark-ready true|false] [--force]
  crucible sign <run-dir> [--base <ref>] [--branch <name>] [--ticket <url>] [--heavy]
  crucible lock [--timeout <sec>] [--cwd <dir>] -- <cmd...>
  crucible verify <run-dir> [--repo <dir>] [--timeout <sec>] -- <cmd...>
  crucible record-tidy <run-dir> [--repo <dir>] [--summary <text>]
  crucible record-council <run-dir> [--repo <dir>] [--round <n>] --scores <json> --blockers <n> [--majors <n>] [--fix-majors <n>] [--areas <a,b>] [--notes <text>]
  crucible record-council <run-dir> --followup [--repo <dir>] [--notes <text>]
  crucible record-pr <run-dir> --url <url> [--ready]
  crucible record-ci <run-dir> [--repo <dir>] --status <green|failed> [--sha <sha>]
  crucible budget <run-dir> <council|ci|watch> [--consume]
  crucible gate <run-dir> <implement|tidy|council|pr-open|pr-ready|pr-watch|done> [--repo <dir>] [--override-council]
  crucible pause <run-dir> --reason <text>
  crucible status [<run-dir>] [--all]
  crucible attention
`;

function splitOnDashDash(argv) {
  const idx = argv.indexOf("--");
  if (idx === -1) return { head: argv, cmd: [] };
  return { head: argv.slice(0, idx), cmd: argv.slice(idx + 1) };
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { flags, positional };
}

function parseBoolFlag(val) {
  if (val === undefined) return null;
  if (val === true || val === "true") return true;
  if (val === false || val === "false") return false;
  throw new Error(`Expected boolean value, got "${val}"`);
}

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs[0] === "-h" || rawArgs[0] === "--help") {
    process.stdout.write(USAGE);
    return;
  }

  const command = rawArgs[0];
  const { head, cmd } = splitOnDashDash(rawArgs.slice(1));
  const { flags, positional } = parseFlags(head);

  switch (command) {
    case "config": {
      printJson(resolveConfig(flags.repo || process.cwd()));
      return;
    }
    case "init": {
      const slug = positional[0];
      if (!slug) throw new Error("init requires <slug>");
      const result = initRun({
        slug,
        repoDir: flags.repo || process.cwd(),
        base: flags.base || "origin/main",
        branch: flags.branch || "",
        ticket: flags.ticket || null,
        markReady: parseBoolFlag(flags["mark-ready"]),
        force: Boolean(flags.force),
      });
      printJson(result);
      return;
    }
    case "sign": {
      const runDir = positional[0];
      if (!runDir) throw new Error("sign requires <run-dir>");
      const result = signRun(runDir, {
        base: flags.base,
        branch: flags.branch,
        ticket: flags.ticket,
        heavy: Boolean(flags.heavy),
      });
      printJson(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "lock": {
      const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : undefined;
      const code = await runWithLock(cmd, { cwd: flags.cwd || process.cwd(), timeoutMs });
      process.exitCode = code;
      return;
    }
    case "verify": {
      const runDir = positional[0];
      if (!runDir) throw new Error("verify requires <run-dir>");
      const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : undefined;
      const workdir = flags.repo || process.cwd();
      const exitCode = await runWithLock(cmd, { cwd: workdir, timeoutMs });
      const result = recordVerify(runDir, { repoDir: workdir, exitCode });
      printJson(result);
      if (!result.ok) process.exitCode = exitCode || 1;
      return;
    }
    case "record-tidy": {
      const runDir = positional[0];
      if (!runDir) throw new Error("record-tidy requires <run-dir>");
      const result = recordTidy(runDir, {
        repoDir: flags.repo,
        summary: flags.summary || "",
      });
      printJson(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "record-council": {
      const runDir = positional[0];
      if (!runDir) throw new Error("record-council requires <run-dir>");
      if (flags.followup) {
        const result = recordCouncilFollowup(runDir, { repoDir: flags.repo, notes: flags.notes || null });
        printJson(result);
        if (!result.ok) process.exitCode = 1;
        return;
      }
      if (!flags.scores) throw new Error("record-council requires --scores <json>");
      if (flags.blockers === undefined) throw new Error("record-council requires --blockers <n>");
      const result = recordCouncil(runDir, {
        repoDir: flags.repo,
        round: flags.round ? Number(flags.round) : undefined,
        scores: JSON.parse(flags.scores),
        blockers: Number(flags.blockers),
        majors: flags.majors === undefined ? undefined : Number(flags.majors),
        fixMajors: flags["fix-majors"] === undefined ? 0 : Number(flags["fix-majors"]),
        areas: typeof flags.areas === "string" ? flags.areas : undefined,
        notes: flags.notes || null,
      });
      printJson(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "record-pr": {
      const runDir = positional[0];
      if (!runDir) throw new Error("record-pr requires <run-dir>");
      const result = recordPr(runDir, {
        url: flags.url,
        ready: parseBoolFlag(flags.ready),
      });
      printJson(result);
      return;
    }
    case "record-ci": {
      const runDir = positional[0];
      if (!runDir) throw new Error("record-ci requires <run-dir>");
      const result = recordCi(runDir, {
        repoDir: flags.repo,
        status: flags.status,
        sha: flags.sha || null,
      });
      printJson(result);
      return;
    }
    case "budget": {
      const [runDir, kind] = positional;
      if (!runDir || !kind) throw new Error("budget requires <run-dir> <council|ci|watch>");
      const result = checkBudget(runDir, kind, { consume: Boolean(flags.consume) });
      printJson(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "gate": {
      const [runDir, phase] = positional;
      if (!runDir || !phase) throw new Error("gate requires <run-dir> <phase>");
      const result = gatePhase(runDir, phase, {
        repoDir: flags.repo,
        overrideCouncil: Boolean(flags["override-council"]),
      });
      printJson(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "pause": {
      const runDir = positional[0];
      if (!runDir) throw new Error("pause requires <run-dir>");
      const result = pauseRun(runDir, { reason: flags.reason });
      printJson(result);
      return;
    }
    case "status": {
      if (flags.all || positional.length === 0) {
        printJson({ runs: listRuns() });
      } else {
        printJson(getStatus(positional[0]));
      }
      return;
    }
    case "attention": {
      const res = spawnSync("sh", [ATTENTION_SCRIPT], { stdio: "inherit", env: process.env });
      if (res.error) throw res.error;
      process.exitCode = res.status ?? 1;
      return;
    }
    default:
      throw new Error(`Unknown command: "${command}". Run \`crucible --help\`.`);
  }
}

main().catch((err) => {
  process.stderr.write(`crucible error: ${err.message}\n`);
  process.exitCode = 1;
});
