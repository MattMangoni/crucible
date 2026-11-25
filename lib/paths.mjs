import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(input) {
  if (!input) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function getConfigPath() {
  if (process.env.CRUCIBLE_CONFIG) return expandHome(process.env.CRUCIBLE_CONFIG);
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "crucible", "config.json");
}

export function getStateRoot() {
  if (process.env.CRUCIBLE_STATE_DIR) return expandHome(process.env.CRUCIBLE_STATE_DIR);
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "crucible", "runs");
}

export function getLockDir() {
  if (process.env.CRUCIBLE_LOCK_DIR) return expandHome(process.env.CRUCIBLE_LOCK_DIR);
  return path.join(os.tmpdir(), "crucible-heavy.lock");
}

export function sanitizeSlug(raw) {
  const cleaned = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.includes("..")) {
    throw new Error(`Invalid run slug: "${raw}"`);
  }
  return cleaned;
}

export function repoKey(repoPath) {
  const resolved = path.resolve(expandHome(repoPath));
  const base = path.basename(resolved).replace(/[^a-zA-Z0-9._-]+/g, "-") || "repo";
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

export function globMatch(pattern, targetPath) {
  const normPattern = path.resolve(expandHome(pattern)).replace(/\\/g, "/");
  const normTarget = path.resolve(expandHome(targetPath)).replace(/\\/g, "/");
  let regex = "^";
  for (let i = 0; i < normPattern.length; i += 1) {
    const ch = normPattern[i];
    if (ch === "*") {
      if (normPattern[i + 1] === "*") {
        regex += ".*";
        i += 1;
      } else {
        regex += "[^/]*";
      }
    } else if (ch === "?") {
      regex += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
  }
  regex += "$";
  return new RegExp(regex).test(normTarget);
}

export function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function tryGitTopLevel(dir) {
  try {
    return git(["rev-parse", "--show-toplevel"], dir);
  } catch {
    return null;
  }
}

export function getGitSnapshot(dir) {
  const topLevel = git(["rev-parse", "--show-toplevel"], dir);
  let head = null;
  try {
    head = git(["rev-parse", "HEAD"], topLevel);
  } catch {
    head = null;
  }
  let branch = null;
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"], topLevel);
  } catch {
    branch = null;
  }
  const porcelain = git(["status", "--porcelain"], topLevel);
  return {
    topLevel,
    head,
    branch,
    clean: porcelain.length === 0,
    dirtyFiles: porcelain ? porcelain.split("\n").filter(Boolean) : [],
  };
}

export function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}
