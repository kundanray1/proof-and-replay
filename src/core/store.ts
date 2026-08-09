import fs from "node:fs";
import path from "node:path";
import { eventId, runId as createRunId } from "./ids.js";
import { statePaths } from "./paths.js";
import type {
  AppendEventInput,
  LedgerEvent,
  ProofReplayConfig,
  ProofRun,
  RepositoryGraph,
  StatePaths
} from "../types.js";

const DEFAULT_CONFIG: ProofReplayConfig = {
  schemaVersion: 1,
  sourceExtensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"],
  exclude: [
    ".git",
    ".proof-replay",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next"
  ],
  proofPolicy: {
    requireReproduction: true,
    requireChange: true,
    requirePassingVerification: true,
    requireExecutedChangedNode: true
  }
};

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

export function ensureState(root: string): StatePaths {
  const paths = statePaths(root);
  fs.mkdirSync(paths.directory, { recursive: true });
  fs.mkdirSync(paths.coverage, { recursive: true });
  if (!fs.existsSync(paths.config)) writeJsonAtomic(paths.config, DEFAULT_CONFIG);
  if (!fs.existsSync(paths.runs)) writeJsonAtomic(paths.runs, []);
  if (!fs.existsSync(paths.events)) fs.writeFileSync(paths.events, "", "utf8");
  return paths;
}

export function readConfig(root: string): ProofReplayConfig {
  const paths = ensureState(root);
  return JSON.parse(fs.readFileSync(paths.config, "utf8")) as ProofReplayConfig;
}

export function writeGraph(root: string, graph: RepositoryGraph): void {
  const paths = ensureState(root);
  writeJsonAtomic(paths.graph, graph);
}

export function readGraph(root: string): RepositoryGraph | null {
  const paths = ensureState(root);
  if (!fs.existsSync(paths.graph)) return null;
  return JSON.parse(fs.readFileSync(paths.graph, "utf8")) as RepositoryGraph;
}

export function readRuns(root: string): ProofRun[] {
  const paths = ensureState(root);
  return JSON.parse(fs.readFileSync(paths.runs, "utf8")) as ProofRun[];
}

export function getRun(root: string, id: string): ProofRun | null {
  return readRuns(root).find((run) => run.id === id) ?? null;
}

export function createRun(root: string, prompt: string): ProofRun {
  const paths = ensureState(root);
  const runs = readRuns(root);
  const run: ProofRun = {
    id: createRunId(),
    prompt,
    status: "running",
    createdAt: new Date().toISOString(),
    completedAt: null
  };
  runs.push(run);
  writeJsonAtomic(paths.runs, runs);
  appendEvent(root, {
    runId: run.id,
    type: "task.started",
    status: "running",
    data: { prompt }
  });
  return run;
}

export function updateRun(
  root: string,
  id: string,
  changes: Partial<Omit<ProofRun, "id">>
): ProofRun {
  const paths = ensureState(root);
  const runs = readRuns(root);
  const index = runs.findIndex((run) => run.id === id);
  if (index === -1) throw new Error(`Unknown run: ${id}`);
  const current = runs[index];
  if (!current) throw new Error(`Unknown run: ${id}`);
  runs[index] = { ...current, ...changes };
  writeJsonAtomic(paths.runs, runs);
  return runs[index]!;
}

export function readEvents(root: string, runId?: string): LedgerEvent[] {
  const paths = ensureState(root);
  const text = fs.readFileSync(paths.events, "utf8").trim();
  if (!text) return [];
  const events = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEvent);
  return runId ? events.filter((event) => event.runId === runId) : events;
}

export function appendEvent(root: string, input: AppendEventInput): LedgerEvent {
  const paths = ensureState(root);
  const previous = readEvents(root);
  const event: LedgerEvent = {
    schemaVersion: 1,
    id: eventId(),
    seq: (previous.at(-1)?.seq ?? 0) + 1,
    timestamp: new Date().toISOString(),
    runId: input.runId,
    type: input.type,
    status: input.status ?? "observed",
    nodeIds: [...new Set(input.nodeIds ?? [])],
    data: input.data ?? {}
  };
  fs.appendFileSync(paths.events, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export function resetState(root: string): void {
  const paths = statePaths(root);
  if (!fs.existsSync(paths.directory)) return;
  for (const name of ["events.ndjson", "runs.json", "graph.json"]) {
    const file = path.join(paths.directory, name);
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  ensureState(root);
}
