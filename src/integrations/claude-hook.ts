#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { appendEvent, createRun, getRun, readEvents, readGraph } from "../core/store.js";
import { scanProject } from "../core/scanner.js";
import { statePaths, toProjectPath } from "../core/paths.js";
import { readConfig } from "../core/store.js";
import { readClaudeTokenUsage, tokenUsageFromToolResponse } from "./token-usage.js";
import type { ProofRun, RepositoryGraph, TokenUsage } from "../types.js";

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
  transcript_path?: string;
  tool_response?: unknown;
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
  const fileNodes = graph.nodes.filter((node) => node.file === relative);
  const projectIds = new Set(fileNodes.map((node) => node.data.projectId).filter((id): id is string => typeof id === "string"));
  return [...new Set([...fileNodes.map((node) => node.id), ...projectIds])];
}

function commandNodes(root: string, command: string, graph: RepositoryGraph): { nodeIds: string[]; files: string[] } {
  const normalized = command.replaceAll("\\", "/");
  const matchedFiles = graph.nodes.filter((node) => node.kind === "file" && (
    normalized.includes(node.file) || normalized.includes(path.resolve(root, node.file).replaceAll("\\", "/"))
  ));
  const matchedProjects = (graph.architecture?.projects ?? []).filter((project) => project.path !== "." && (
    normalized.includes(`${project.path}/`) || normalized.includes(path.resolve(root, project.path).replaceAll("\\", "/"))
  ));
  const projectIds = new Set<string>(matchedProjects.map((project) => project.id));
  for (const file of matchedFiles) {
    if (typeof file.data.projectId === "string") projectIds.add(file.data.projectId);
  }
  if (projectIds.size === 0) {
    const rootProject = graph.architecture?.projects.find((project) => project.path === ".");
    if (rootProject && normalized.includes(root.replaceAll("\\", "/"))) projectIds.add(rootProject.id);
  }
  return {
    nodeIds: [...new Set([...projectIds, ...matchedFiles.map((node) => node.id)])],
    files: [...new Set(matchedFiles.map((node) => node.file))]
  };
}

function looksLikeTest(command = ""): boolean {
  return /(?:^|[;&|]\s*|\s)(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|bun\s+test|node\s+--test|pytest|uv\s+run\s+pytest|vitest|jest|(?:npx\s+)?playwright\s+test|(?:npx\s+)?cypress\s+run)(?:\s|$)/i.test(command);
}

function looksLikeMutation(command: string): boolean {
  return /(?:apply_patch|sed\s+(?:-[^\s]*i|--in-place)|perl\s+-[^\s]*i|(?:cat|tee)\s+[^\n]*(?:>|--append)|writeFile|appendFile|renameSync|copyFile)/i.test(command);
}

function usageForPayload(payload: ClaudeHookPayload): TokenUsage | null {
  return readClaudeTokenUsage(payload.transcript_path) ?? tokenUsageFromToolResponse(payload.tool_response);
}

function recordTokenUsage(root: string, run: ProofRun, payload: ClaudeHookPayload): void {
  const usage = usageForPayload(payload);
  if (!usage) return;
  const prior = readEvents(root, run.id).filter((event) => event.type === "usage.sampled").at(-1);
  const previousTotal = typeof prior?.data.totalTokens === "number" ? prior.data.totalTokens : 0;
  if (usage.totalTokens === previousTotal) return;
  const config = readConfig(root).tokenMonitoring;
  const deltaTokens = Math.max(0, usage.totalTokens - previousTotal);
  appendEvent(root, {
    runId: run.id,
    type: "usage.sampled",
    status: "observed",
    data: {
      ...usage,
      deltaTokens,
      warning: usage.totalTokens >= config.sessionWarningTokens || deltaTokens >= config.turnSpikeTokens,
      sessionWarningTokens: config.sessionWarningTokens,
      turnSpikeTokens: config.turnSpikeTokens
    }
  });
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
  recordTokenUsage(root, run, payload);

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
    const graph = readGraph(root) ?? scanProject(root);
    const mapped = commandNodes(root, command, graph);
    appendEvent(root, {
      runId: run.id,
      type: failed ? "tool.failed" : "tool.completed",
      status: failed ? "failed" : "passed",
      nodeIds: mapped.nodeIds,
      data: { tool, command, error: payload.error, durationMs: payload.duration_ms }
    });
    if (!failed && mapped.files.length > 0 && looksLikeMutation(command)) {
      scanProject(root);
      appendEvent(root, {
        runId: run.id,
        type: "file.changed",
        status: "changed",
        nodeIds: mapped.files.flatMap((file) => nodesForFile(root, file)),
        data: { files: mapped.files, tool, capturedBy: "claude-hook-command" }
      });
    }
    if (looksLikeTest(command) && !command.includes("proof-replay")) {
      const projectIds = new Set(mapped.nodeIds.filter((id) => graph.nodes.find((node) => node.id === id)?.kind === "project"));
      const testNodes = graph.nodes.filter((node) => node.kind === "test" && (
        projectIds.size === 0 || (typeof node.data.projectId === "string" && projectIds.has(node.data.projectId))
      ));
      appendEvent(root, {
        runId: run.id,
        type: "test.completed",
        status: failed ? "failed" : "passed",
        nodeIds: [...mapped.nodeIds, ...testNodes.map((node) => node.id)],
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
