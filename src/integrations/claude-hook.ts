#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { appendEvent, createRun, getRun, readEvents, readGraph } from "../core/store.js";
import { scanProject } from "../core/scanner.js";
import { statePaths, toProjectPath } from "../core/paths.js";
import type { ProofRun } from "../types.js";

interface ClaudeHookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: {
    command?: string;
    file_path?: string;
    path?: string;
    pattern?: string;
  };
  error?: unknown;
  duration_ms?: number;
}

interface ActiveClaudeRun {
  runId: string;
  sessionId: string | null;
  attachedAt: string;
}

function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.once("end", () => resolve(input));
    process.stdin.once("error", reject);
  });
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function activeRun(root: string, payload: ClaudeHookPayload): ProofRun | null {
  const paths = statePaths(root);
  if (!fs.existsSync(paths.claudeActive)) {
    if (payload.hook_event_name !== "UserPromptSubmit") return null;
    const run = createRun(root, payload.prompt ?? "Claude coding session");
    writeJsonAtomic(paths.claudeActive, {
      runId: run.id,
      sessionId: payload.session_id,
      attachedAt: new Date().toISOString()
    });
    return run;
  }

  const active = JSON.parse(fs.readFileSync(paths.claudeActive, "utf8")) as ActiveClaudeRun;
  if (active.sessionId && payload.session_id && active.sessionId !== payload.session_id) return null;
  if (!active.sessionId && payload.session_id) {
    active.sessionId = payload.session_id;
    writeJsonAtomic(paths.claudeActive, active);
  }
  const run = getRun(root, active.runId);
  return run?.status === "running" ? run : null;
}

function nodesForFile(root: string, file?: string): string[] {
  if (!file) return [];
  const relative = toProjectPath(root, path.resolve(root, file));
  const graph = readGraph(root) ?? scanProject(root);
  return graph.nodes.filter((node) => node.file === relative).map((node) => node.id);
}

function looksLikeTest(command = ""): boolean {
  return /(?:^|[;&|]\s*|\s)(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|bun\s+test|node\s+--test|pytest|uv\s+run\s+pytest|vitest|jest)(?:\s|$)/i.test(command);
}

function testStage(root: string, runId: string): "reproduce" | "verify" {
  return readEvents(root, runId).some((event) => event.type === "file.changed")
    ? "verify"
    : "reproduce";
}

function record(root: string, run: ProofRun, payload: ClaudeHookPayload): void {
  const eventName = payload.hook_event_name;
  const tool = payload.tool_name;
  const input = payload.tool_input ?? {};

  if (eventName === "UserPromptSubmit") {
    appendEvent(root, {
      runId: run.id,
      type: "agent.prompted",
      status: "active",
      data: { prompt: payload.prompt ?? "", sessionId: payload.session_id }
    });
    return;
  }

  if (eventName === "Stop") {
    appendEvent(root, {
      runId: run.id,
      type: "agent.stopped",
      status: "observed",
      data: { sessionId: payload.session_id }
    });
    return;
  }

  if (tool && ["Read", "Glob", "Grep"].includes(tool)) {
    const file = input.file_path ?? input.path;
    appendEvent(root, {
      runId: run.id,
      type: "node.inspected",
      status: "active",
      nodeIds: nodesForFile(root, file),
      data: { tool, file, pattern: input.pattern }
    });
    return;
  }

  if (tool && ["Edit", "Write"].includes(tool)) {
    scanProject(root);
    const file = input.file_path;
    appendEvent(root, {
      runId: run.id,
      type: "file.changed",
      status: "changed",
      nodeIds: nodesForFile(root, file),
      data: { files: file ? [toProjectPath(root, path.resolve(root, file))] : [], tool }
    });
    return;
  }

  if (tool === "Bash") {
    const failed = eventName === "PostToolUseFailure";
    const command = input.command ?? "";
    appendEvent(root, {
      runId: run.id,
      type: failed ? "tool.failed" : "tool.completed",
      status: failed ? "failed" : "passed",
      data: { tool, command, error: payload.error, durationMs: payload.duration_ms }
    });
    if (looksLikeTest(command) && !command.includes("proof-replay")) {
      appendEvent(root, {
        runId: run.id,
        type: "test.completed",
        status: failed ? "failed" : "passed",
        nodeIds: (readGraph(root)?.nodes ?? [])
          .filter((node) => node.kind === "test")
          .map((node) => node.id),
        data: { command, stage: testStage(root, run.id), capturedBy: "claude-hook" }
      });
    }
  }
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return;
  const payload = JSON.parse(raw) as ClaudeHookPayload;
  const root = path.resolve(payload.cwd ?? process.cwd());
  const run = activeRun(root, payload);
  if (run) record(root, run, payload);
}

main().catch((error: unknown) => {
  try {
    const root = process.cwd();
    const directory = statePaths(root).directory;
    fs.mkdirSync(directory, { recursive: true });
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    fs.appendFileSync(path.join(directory, "hook-errors.log"), `${new Date().toISOString()} ${detail}\n`);
  } catch {
    // Hooks are observational and must never interrupt the coding agent.
  }
});
