import fs from "node:fs";
import path from "node:path";
import { eventId, runId as createRunId, stableId } from "./ids.js";
import { statePaths } from "./paths.js";
import { createSessionCycle, eventContext, migrateLegacySessions, projectSessionEvent, readSessions, reconcileStoppedCycles } from "./sessions.js";
import type {
  AppendEventInput,
  LedgerEvent,
  ProofReplayConfig,
  ProofRun,
  RepositoryGraph,
  SessionRecord,
  StatePaths
} from "../types.js";

export interface CreateRunOptions {
  sessionId?: string;
  externalSessionId?: string | null;
  parentCycleId?: string | null;
  provider?: SessionRecord["provider"];
}

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
    ".next",
    ".worktrees",
    ".wrangler",
    ".turbo",
    ".cache",
    "test-results",
    "playwright-report"
  ],
  proofPolicy: {
    requireReproduction: true,
    requireChange: true,
    requirePassingVerification: true,
    requireExecutedChangedNode: true
  },
  tokenMonitoring: {
    sessionWarningTokens: 200_000,
    turnSpikeTokens: 50_000
  },
  workflowContracts: []
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
  fs.mkdirSync(paths.baselines, { recursive: true });
  if (!fs.existsSync(paths.config)) writeJsonAtomic(paths.config, DEFAULT_CONFIG);
  if (!fs.existsSync(paths.runs)) writeJsonAtomic(paths.runs, []);
  if (!fs.existsSync(paths.sessions)) writeJsonAtomic(paths.sessions, []);
  if (!fs.existsSync(paths.events)) fs.writeFileSync(paths.events, "", "utf8");
  return paths;
}

export function readConfig(root: string): ProofReplayConfig {
  const paths = ensureState(root);
  const stored = JSON.parse(fs.readFileSync(paths.config, "utf8")) as Partial<ProofReplayConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    exclude: [...new Set([...DEFAULT_CONFIG.exclude, ...(stored.exclude ?? [])])],
    proofPolicy: { ...DEFAULT_CONFIG.proofPolicy, ...stored.proofPolicy },
    tokenMonitoring: { ...DEFAULT_CONFIG.tokenMonitoring, ...stored.tokenMonitoring },
    workflowContracts: stored.workflowContracts ?? []
  };
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
  const stored = JSON.parse(fs.readFileSync(paths.runs, "utf8")) as Array<Partial<ProofRun> & Pick<ProofRun, "id" | "prompt" | "status" | "createdAt" | "completedAt">>;
  return stored.map((run) => ({
    ...run,
    sessionId: run.sessionId ?? stableId("session", run.id),
    cycleId: run.cycleId ?? stableId("cycle", run.id)
  }));
}

export function getRun(root: string, id: string): ProofRun | null {
  return readRuns(root).find((run) => run.id === id) ?? null;
}

export function createRun(root: string, prompt: string, options: CreateRunOptions = {}): ProofRun {
  const paths = ensureState(root);
  const runs = readRuns(root);
  const id = createRunId();
  const trace = createSessionCycle(root, {
    runId: id,
    prompt,
    provider: options.provider ?? "manual",
    repositoryRoot: root,
    contracts: readConfig(root).workflowContracts,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.externalSessionId !== undefined ? { externalSessionId: options.externalSessionId } : {}),
    ...(options.parentCycleId !== undefined ? { parentCycleId: options.parentCycleId } : {})
  });
  const run: ProofRun = {
    id,
    sessionId: trace.session.id,
    cycleId: trace.cycle.id,
    prompt,
    status: "running",
    createdAt: new Date().toISOString(),
    completedAt: null
  };
  runs.push(run);
  writeJsonAtomic(paths.runs, runs);
  appendEvent(root, {
    runId: run.id,
    sessionId: run.sessionId,
    cycleId: run.cycleId,
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
    .map((line) => {
      const event = JSON.parse(line) as Partial<LedgerEvent> & Pick<LedgerEvent, "id" | "seq" | "timestamp" | "runId" | "type" | "status" | "nodeIds" | "data">;
      return {
        ...event,
        schemaVersion: event.schemaVersion ?? 1,
        sessionId: event.sessionId ?? null,
        cycleId: event.cycleId ?? null,
        promptId: event.promptId ?? null,
        workflowRunId: event.workflowRunId ?? null,
        agentRunId: event.agentRunId ?? null,
        parentEventId: event.parentEventId ?? null
      } as LedgerEvent;
    });
  return runId ? events.filter((event) => event.runId === runId) : events;
}

export function appendEvent(root: string, input: AppendEventInput): LedgerEvent {
  const paths = ensureState(root);
  const previous = readEvents(root);
  const run = getRun(root, input.runId);
  if (!run) throw new Error(`Unknown run: ${input.runId}`);
  const context = eventContext(root, run, input);
  const event: LedgerEvent = {
    schemaVersion: 2,
    id: eventId(),
    seq: (previous.at(-1)?.seq ?? 0) + 1,
    timestamp: new Date().toISOString(),
    runId: input.runId,
    ...context,
    type: input.type,
    status: input.status ?? "observed",
    nodeIds: [...new Set(input.nodeIds ?? [])],
    data: input.data ?? {}
  };
  fs.appendFileSync(paths.events, `${JSON.stringify(event)}\n`, "utf8");
  projectSessionEvent(root, event);
  return event;
}

export function readSessionRecords(root: string): SessionRecord[] {
  let sessions = readSessions(root);
  const runs = readRuns(root);
  const events = readEvents(root);
  if (sessions.length === 0) sessions = migrateLegacySessions(root, runs, events);
  const finalizedRunIds = reconcileStoppedCycles(root, runs, events);
  if (finalizedRunIds.length > 0) {
    const finalized = new Set(finalizedRunIds);
    const nextRuns = runs.map((run) => finalized.has(run.id) && run.status === "running"
      ? { ...run, status: "stopped" as const, completedAt: events.filter((event) => event.runId === run.id && event.type === "agent.stopped").at(-1)?.timestamp ?? new Date().toISOString() }
      : run);
    writeJsonAtomic(statePaths(root).runs, nextRuns);
    sessions = readSessions(root);
  }
  return sessions;
}

export function resetState(root: string): void {
  const paths = statePaths(root);
  if (!fs.existsSync(paths.directory)) return;
  for (const name of ["events.ndjson", "runs.json", "sessions.json", "graph.json"]) {
    const file = path.join(paths.directory, name);
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  if (fs.existsSync(paths.baselines)) fs.rmSync(paths.baselines, { recursive: true, force: true });
  ensureState(root);
}
