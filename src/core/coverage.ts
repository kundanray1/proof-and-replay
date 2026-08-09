import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { appendEvent, readGraph } from "./store.js";
import { statePaths, toProjectPath } from "./paths.js";
import type { RepositoryGraph } from "../types.js";

interface V8CoverageRange {
  startOffset: number;
  endOffset: number;
  count: number;
}

interface V8CoverageFunction {
  ranges?: V8CoverageRange[];
}

interface V8CoverageScript {
  url?: string;
  functions?: V8CoverageFunction[];
}

interface V8CoveragePayload {
  result?: V8CoverageScript[];
}

export interface RunTestsOptions {
  runId: string;
  stage: "reproduce" | "verify";
  command: string;
  args: string[];
}

export interface RunTestsResult {
  exitCode: number;
  nodeIds: string[];
  coverageDirectory: string;
}

export interface FunctionExecutionCount {
  nodeId: string;
  count: number;
}

function coverageFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(directory, name));
}

function scriptPath(url: string): string | null {
  try {
    if (url.startsWith("file://")) return fileURLToPath(url);
  } catch {
    return null;
  }
  return path.isAbsolute(url) ? url : null;
}

export function collectExecutionCounts(
  root: string,
  directory: string,
  graph: RepositoryGraph | null = readGraph(root)
): FunctionExecutionCount[] {
  if (!graph) return [];
  const executedRanges = new Map<string, V8CoverageRange[]>();

  for (const file of coverageFiles(directory)) {
    let payload: V8CoveragePayload;
    try {
      payload = JSON.parse(fs.readFileSync(file, "utf8")) as V8CoveragePayload;
    } catch {
      continue;
    }
    for (const script of payload.result ?? []) {
      const absolute = scriptPath(script.url ?? "");
      if (!absolute || !absolute.startsWith(`${root}${path.sep}`)) continue;
      const relative = toProjectPath(root, absolute);
      if (!executedRanges.has(relative)) executedRanges.set(relative, []);
      for (const [index, fn] of (script.functions ?? []).entries()) {
        if (index === 0) continue;
        const range = fn.ranges?.find((candidate) => candidate.count > 0);
        if (range) executedRanges.get(relative)!.push(range);
      }
    }
  }

  return graph.nodes
    .filter((node) => node.kind === "function" || node.kind === "test")
    .map((node): FunctionExecutionCount | null => {
      const ranges = executedRanges.get(node.file) ?? [];
      const matches = ranges.filter((range) => {
        const startDelta = Math.abs(range.startOffset - node.start);
        const containsStart = range.startOffset <= node.start && range.endOffset >= node.start;
        const comparableSize = range.endOffset - range.startOffset <= node.end - node.start + 120;
        return startDelta <= 24 || (containsStart && comparableSize);
      });
      if (matches.length === 0) return null;
      return { nodeId: node.id, count: matches.reduce((total, range) => total + range.count, 0) };
    })
    .filter((item): item is FunctionExecutionCount => item !== null);
}

export function collectExecutedNodes(
  root: string,
  directory: string,
  graph: RepositoryGraph | null = readGraph(root)
): string[] {
  return collectExecutionCounts(root, directory, graph).map((item) => item.nodeId);
}

export async function runTests(root: string, options: RunTestsOptions): Promise<RunTestsResult> {
  const paths = statePaths(root);
  const slug = `${options.runId}-${options.stage}-${Date.now()}`;
  const directory = path.join(paths.coverage, slug);
  fs.mkdirSync(directory, { recursive: true });

  appendEvent(root, {
    runId: options.runId,
    type: "test.started",
    status: "running",
    data: { command: [options.command, ...options.args].join(" "), stage: options.stage }
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: root,
      env: { ...process.env, NODE_V8_COVERAGE: directory },
      stdio: "inherit",
      shell: process.platform === "win32"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });

  const executions = collectExecutionCounts(root, directory);
  const nodeIds = executions.map((item) => item.nodeId);
  appendEvent(root, {
    runId: options.runId,
    type: "node.executed",
    status: "observed",
    nodeIds,
    data: { count: nodeIds.length, executions, stage: options.stage }
  });
  appendEvent(root, {
    runId: options.runId,
    type: "test.completed",
    status: exitCode === 0 ? "passed" : "failed",
    nodeIds,
    data: {
      command: [options.command, ...options.args].join(" "),
      stage: options.stage,
      exitCode
    }
  });

  return { exitCode, nodeIds, coverageDirectory: directory };
}
