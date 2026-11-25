import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getLockDir, readJsonIfExists, writeJsonAtomic } from "./paths.mjs";

const OWNER_FILE = "owner.json";
const ORPHAN_GRACE_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function tryReclaimStaleLock(lockDir) {
  const ownerPath = path.join(lockDir, OWNER_FILE);
  const owner = readJsonIfExists(ownerPath);
  if (owner) {
    if (owner.hostname === os.hostname() && !isPidAlive(owner.pid)) {
      fs.rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
    return false;
  }
  // If owner.json hasn't appeared after the grace window, treat the dir as orphaned.
  try {
    const stat = fs.statSync(lockDir);
    if (Date.now() - stat.mtimeMs > ORPHAN_GRACE_MS) {
      fs.rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

export async function acquireLock({
  lockDir = getLockDir(),
  timeoutMs = 15 * 60 * 1000,
  pollMs = 200,
  command = "",
} = {}) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      writeJsonAtomic(path.join(lockDir, OWNER_FILE), {
        pid: process.pid,
        hostname: os.hostname(),
        token,
        command,
        startedAt: new Date().toISOString(),
      });
      return { lockDir, token };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      if (tryReclaimStaleLock(lockDir)) continue;
      if (Date.now() >= deadline) {
        const owner = readJsonIfExists(path.join(lockDir, OWNER_FILE));
        const holder = owner ? `pid=${owner.pid} cmd="${owner.command}" since=${owner.startedAt}` : "unknown holder";
        throw new Error(`Timed out waiting for heavy-command lock (${lockDir}, held by ${holder})`);
      }
      await sleep(pollMs);
    }
  }
}

export function releaseLock(handle) {
  if (!handle?.lockDir) return;
  const ownerPath = path.join(handle.lockDir, OWNER_FILE);
  const owner = readJsonIfExists(ownerPath);
  if (owner && owner.token !== handle.token) return;
  fs.rmSync(handle.lockDir, { recursive: true, force: true });
}

export async function runWithLock(cmdArgs, { cwd = process.cwd(), timeoutMs, lockDir } = {}) {
  if (!Array.isArray(cmdArgs) || cmdArgs.length === 0) {
    throw new Error("No command provided to run under lock.");
  }
  const handle = await acquireLock({
    lockDir,
    timeoutMs,
    command: cmdArgs.join(" "),
  });

  const child = spawn(cmdArgs[0], cmdArgs.slice(1), {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  const forward = (sig) => {
    try {
      child.kill(sig);
    } catch {
      // Child already exited.
    }
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (signal) resolve(128);
        else resolve(code ?? 1);
      });
    });
    return exitCode;
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
    releaseLock(handle);
  }
}
