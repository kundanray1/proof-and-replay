import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRun, ensureState, getRun, updateRun } from "../core/store.js";
import { scanProject } from "../core/scanner.js";
import { statePaths } from "../core/paths.js";
import type { ProofRun } from "../types.js";

const MODULE_FILE = fileURLToPath(import.meta.url);
const RUNNING_TYPESCRIPT_SOURCE = path.extname(MODULE_FILE) === ".ts";
const TSX_IMPORT = RUNNING_TYPESCRIPT_SOURCE ? import.meta.resolve("tsx") : null;
const HOOK_SCRIPT = fileURLToPath(
  new URL(RUNNING_TYPESCRIPT_SOURCE ? "./claude-hook.ts" : "./claude-hook.js", import.meta.url)
);

type ClaudeHookEvent = "UserPromptSubmit" | "PostToolUse" | "PostToolUseFailure" | "Stop" | "SubagentStart" | "SubagentStop";

interface ClaudeHookCommand {
  type: "command";
  command: string;
  args: string[];
  timeout: number;
}

interface ClaudeHookGroup {
  hooks: ClaudeHookCommand[];
  matcher?: string;
}

interface ClaudeSettings {
  hooks?: Partial<Record<ClaudeHookEvent, ClaudeHookGroup[]>>;
  [key: string]: unknown;
}

interface ActiveClaudeRun {
  runId: string;
  sessionId: string | null;
  attachedAt: string;
}

export interface ClaudeHookInstallation {
  settingsFile: string;
  hookScript: string;
  changes: number;
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function hookHandler(): ClaudeHookCommand {
  return {
    type: "command",
    command: process.execPath,
    args: RUNNING_TYPESCRIPT_SOURCE && TSX_IMPORT
      ? ["--import", TSX_IMPORT, HOOK_SCRIPT]
      : [HOOK_SCRIPT],
    timeout: 30
  };
}

function addHook(
  settings: ClaudeSettings,
  event: ClaudeHookEvent,
  matcher?: string
): boolean {
  settings.hooks ??= {};
  settings.hooks[event] ??= [];
  const command = process.execPath;
  const installedGroup = settings.hooks[event].find((group) =>
    group.hooks?.some(
      (hook) => hook.command === command && hook.args?.includes(HOOK_SCRIPT)
    )
  );
  if (installedGroup) {
    if (matcher && installedGroup.matcher !== matcher) {
      installedGroup.matcher = matcher;
      return true;
    }
    return false;
  }
  const group: ClaudeHookGroup = { hooks: [hookHandler()] };
  if (matcher) group.matcher = matcher;
  settings.hooks[event].push(group);
  return true;
}

export function installClaudeHooks(root: string): ClaudeHookInstallation {
  ensureState(root);
  const claudeDirectory = path.join(root, ".claude");
  const settingsFile = path.join(claudeDirectory, "settings.local.json");
  let settings: ClaudeSettings = {};
  if (fs.existsSync(settingsFile)) {
    settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as ClaudeSettings;
  }

  const changes = [
    addHook(settings, "UserPromptSubmit"),
    addHook(settings, "PostToolUse", "Read|Glob|Grep|Edit|Write|Bash|Agent|TaskCreate|TaskUpdate|TaskStop|TaskOutput"),
    addHook(settings, "PostToolUseFailure", "Bash|Agent|TaskCreate|TaskUpdate|TaskStop|TaskOutput"),
    addHook(settings, "Stop"),
    addHook(settings, "SubagentStart"),
    addHook(settings, "SubagentStop")
  ].filter(Boolean).length;

  writeJsonAtomic(settingsFile, settings);
  return { settingsFile, hookScript: HOOK_SCRIPT, changes };
}

export function attachClaude(root: string, prompt: string): ProofRun {
  ensureState(root);
  scanProject(root);
  const paths = statePaths(root);
  let run = null;
  if (fs.existsSync(paths.claudeActive)) {
    const active = JSON.parse(fs.readFileSync(paths.claudeActive, "utf8")) as ActiveClaudeRun;
    run = getRun(root, active.runId);
    if (run?.status !== "running") run = null;
  }
  if (!run) run = createRun(root, prompt);
  writeJsonAtomic(paths.claudeActive, {
    runId: run.id,
    sessionId: null,
    attachedAt: new Date().toISOString()
  });
  return run;
}

export function detachClaude(root: string): ProofRun | null {
  const paths = statePaths(root);
  if (!fs.existsSync(paths.claudeActive)) return null;
  const active = JSON.parse(fs.readFileSync(paths.claudeActive, "utf8")) as ActiveClaudeRun;
  const run = getRun(root, active.runId);
  if (run?.status === "running") {
    updateRun(root, run.id, { status: "detached", completedAt: new Date().toISOString() });
  }
  fs.rmSync(paths.claudeActive);
  return run;
}
