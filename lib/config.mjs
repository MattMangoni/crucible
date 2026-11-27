import path from "node:path";
import { expandHome, getConfigPath, globMatch, readJsonIfExists, tryGitTopLevel } from "./paths.mjs";

export const DEFAULT_CONFIG = {
  council: {
    members: [
      {
        name: "Claude Opus 5.5",
        provider: "claudeAgent",
        model: "claude-opus-5-5",
        options: { effort: "high" },
      },
      {
        name: "GPT 6.2 Sol",
        provider: "codex",
        model: "gpt-6.2-sol",
        options: { reasoningEffort: "high" },
      },
      {
        name: "Gemini 4 Neon",
        provider: "antigravity",
        model: "gemini-4-neon",
        options: { thought_level: "high" },
      },
    ],
    minScore: 9,
    maxRounds: 5,
    specCouncil: "auto",
  },
  budgets: {
    councilRounds: 5,
    ciFixPushes: 3,
    prWatchPushes: 5,
  },
  pr: {
    markReadyOnGreen: true,
    autoMergeCleanBase: true,
    resolveHumanThreads: false,
    language: "en",
    reviewers: [],
    neverMerge: true,
    neverForcePush: true,
  },
  verify: [],
  hooks: {},
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = structuredClone(base);
  for (const [key, val] of Object.entries(override)) {
    if (val === undefined) continue;
    if (isPlainObject(val) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], val);
    } else {
      out[key] = structuredClone(val);
    }
  }
  return out;
}

function extractLayer(obj) {
  if (!isPlainObject(obj)) return {};
  const layer = {};
  for (const key of ["council", "budgets", "pr", "verify", "hooks"]) {
    if (obj[key] !== undefined) layer[key] = obj[key];
  }
  return layer;
}

export function resolveConfig(repoDir = process.cwd()) {
  const resolvedInput = path.resolve(expandHome(repoDir));
  const repoRoot = tryGitTopLevel(resolvedInput) || resolvedInput;

  let merged = structuredClone(DEFAULT_CONFIG);
  const sources = [];

  const userConfigPath = getConfigPath();
  const userConfig = readJsonIfExists(userConfigPath);
  if (userConfig) {
    sources.push(userConfigPath);
    if (userConfig.defaults) {
      merged = deepMerge(merged, extractLayer(userConfig.defaults));
    }
    merged = deepMerge(merged, extractLayer(userConfig));
    if (Array.isArray(userConfig.profiles)) {
      for (const profile of userConfig.profiles) {
        if (profile?.match && globMatch(profile.match, repoRoot)) {
          merged = deepMerge(merged, extractLayer(profile));
        }
      }
    }
  }

  const repoConfigPath = path.join(repoRoot, ".crucible.json");
  const repoConfig = readJsonIfExists(repoConfigPath);
  if (repoConfig) {
    sources.push(repoConfigPath);
    merged = deepMerge(merged, extractLayer(repoConfig));
  }

  // Keep maxRounds aligned with councilRounds budget unless explicitly tightened.
  if (merged.council.maxRounds > merged.budgets.councilRounds) {
    merged.budgets.councilRounds = merged.council.maxRounds;
  }

  // Hard invariants cannot be weakened by user or repo config.
  merged.pr.neverMerge = true;
  merged.pr.neverForcePush = true;

  return {
    repoRoot,
    sources,
    config: merged,
  };
}
