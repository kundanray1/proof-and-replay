import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lifecycleId } from "./ids.js";
import { statePaths } from "./paths.js";
import type {
  AgentRunRecord,
  AppendEventInput,
  DeliverySnapshot,
  GraphNode,
  HookInvocationRecord,
  LedgerEvent,
  NodeDeliveryRole,
  NodeInteraction,
  PromptCycleRecord,
  PromptLifecycle,
  ProofRun,
  RepositoryGraph,
  RepositorySnapshot,
  SessionRecord,
  SessionStatus,
  SkillInvocationRecord,
  WorkflowContract,
  WorkflowRunRecord
} from "../types.js";

interface BaselineEntry {
  file: string;
  snapshot: string;
  existed: boolean;
}

interface BaselineManifest {
  cycleId: string;
  files: BaselineEntry[];
}

interface CycleCreation {
  runId: string;
  prompt: string;
  provider: SessionRecord["provider"];
  repositoryRoot: string;
  sessionId?: string;
  externalSessionId?: string | null;
  parentCycleId?: string | null;
  contracts: WorkflowContract[];
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function git(root: string, args: readonly string[]): string | null {
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8", timeout: 5_000, maxBuffer: 2_000_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function repositorySnapshot(root: string): RepositorySnapshot {
  const head = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) ?? "";
  const diff = git(root, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"]) ?? "";
  const dirtyFiles = status.split("\n").filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
  return {
    capturedAt: new Date().toISOString(),
    head,
    workingTreeHash: createHash("sha256").update(`${status}\n${diff}`).digest("hex"),
    dirtyFiles: unique(dirtyFiles)
  };
}

export function readSessions(root: string): SessionRecord[] {
  const file = statePaths(root).sessions;
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8").trim();
  return text ? JSON.parse(text) as SessionRecord[] : [];
}

export function writeSessions(root: string, sessions: readonly SessionRecord[]): void {
  writeJsonAtomic(statePaths(root).sessions, sessions);
}

function matchingContracts(prompt: string, contracts: readonly WorkflowContract[]): WorkflowContract[] {
  const normalized = prompt.toLowerCase();
  return contracts.filter((contract) => contract.promptIncludes.length === 0 || contract.promptIncludes.every((term) => normalized.includes(term.toLowerCase())));
}

export function createSessionCycle(root: string, input: CycleCreation): { session: SessionRecord; cycle: PromptCycleRecord } {
  const sessions = readSessions(root);
  const now = new Date().toISOString();
  let session = input.sessionId ? sessions.find((candidate) => candidate.id === input.sessionId) : undefined;
  if (!session) {
    session = {
      schemaVersion: 1,
      id: lifecycleId("session"),
      provider: input.provider,
      externalSessionId: input.externalSessionId ?? null,
      repositoryRoot: input.repositoryRoot,
      startedAt: now,
      endedAt: null,
      status: "active",
      cycles: []
    };
    sessions.push(session);
  } else {
    session.status = "active";
    session.endedAt = null;
    if (!session.externalSessionId && input.externalSessionId) session.externalSessionId = input.externalSessionId;
  }

  const rootPromptId = lifecycleId("prompt");
  const rootAgentId = lifecycleId("agent");
  const prompt: PromptLifecycle = {
    id: rootPromptId,
    parentPromptId: null,
    agentRunId: rootAgentId,
    workflowRunId: null,
    kind: "user",
    text: input.prompt,
    startedAt: now,
    stoppedAt: null,
    status: "active",
    deliveredNodeIds: []
  };
  const mainAgent: AgentRunRecord = {
    id: rootAgentId,
    externalAgentId: input.externalSessionId ?? null,
    parentAgentRunId: null,
    parentPromptId: rootPromptId,
    workflowRunId: null,
    agentType: "main",
    model: null,
    description: "Main coding agent",
    startedAt: now,
    stoppedAt: null,
    status: "active",
    tokenUsage: 0
  };
  const workflows: WorkflowRunRecord[] = matchingContracts(input.prompt, input.contracts).map((contract) => ({
    id: lifecycleId("workflow"),
    externalTaskId: null,
    contractId: contract.id,
    parentWorkflowRunId: null,
    parentAgentRunId: rootAgentId,
    parentPromptId: rootPromptId,
    name: contract.name,
    startedAt: now,
    stoppedAt: null,
    status: "planned",
    expectedSkills: unique(contract.requiredSkills),
    expectedHooks: unique(contract.requiredHooks),
    invokedSkills: [],
    observedHooks: []
  }));
  const cycle: PromptCycleRecord = {
    id: lifecycleId("cycle"),
    runId: input.runId,
    ordinal: session.cycles.length + 1,
    parentCycleId: input.parentCycleId ?? session.cycles.at(-1)?.id ?? null,
    prompt: input.prompt,
    startedAt: now,
    stoppedAt: null,
    status: "active",
    baseline: repositorySnapshot(root),
    prompts: [prompt],
    workflows,
    agents: [mainAgent],
    skills: [],
    hooks: [],
    interactions: [],
    delivery: null
  };
  session.cycles.push(cycle);
  writeSessions(root, sessions);
  fs.mkdirSync(path.join(statePaths(root).baselines, cycle.id), { recursive: true });
  return { session, cycle };
}

export function bindExternalSession(root: string, sessionId: string, externalSessionId: string): void {
  const sessions = readSessions(root);
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return;
  session.externalSessionId = externalSessionId;
  const mainAgent = session.cycles.at(-1)?.agents.find((agent) => agent.parentAgentRunId === null);
  if (mainAgent && !mainAgent.externalAgentId) mainAgent.externalAgentId = externalSessionId;
  writeSessions(root, sessions);
}

export function cycleForRun(root: string, runId: string): { session: SessionRecord; cycle: PromptCycleRecord } | null {
  for (const session of readSessions(root)) {
    const cycle = session.cycles.find((candidate) => candidate.runId === runId);
    if (cycle) return { session, cycle };
  }
  return null;
}

export function eventContext(root: string, run: ProofRun, input: AppendEventInput): Pick<LedgerEvent, "sessionId" | "cycleId" | "promptId" | "workflowRunId" | "agentRunId" | "parentEventId"> {
  const found = cycleForRun(root, run.id);
  const cycle = found?.cycle;
  const externalAgent = stringValue(input.data?.agentId) ?? stringValue(input.data?.laneId);
  const agent = input.agentRunId
    ? cycle?.agents.find((candidate) => candidate.id === input.agentRunId)
    : cycle?.agents.find((candidate) => candidate.externalAgentId === externalAgent)
      ?? cycle?.agents.find((candidate) => candidate.parentAgentRunId === null);
  const externalWorkflow = stringValue(input.data?.taskId);
  const workflow = input.workflowRunId
    ? cycle?.workflows.find((candidate) => candidate.id === input.workflowRunId)
    : cycle?.workflows.find((candidate) => candidate.externalTaskId === externalWorkflow);
  const prompt = input.promptId
    ? cycle?.prompts.find((candidate) => candidate.id === input.promptId)
    : [...(cycle?.prompts ?? [])].reverse().find((candidate) => candidate.agentRunId === agent?.id && candidate.status === "active")
      ?? cycle?.prompts[0];
  return {
    sessionId: input.sessionId ?? found?.session.id ?? run.sessionId ?? null,
    cycleId: input.cycleId ?? cycle?.id ?? run.cycleId ?? null,
    promptId: prompt?.id ?? null,
    workflowRunId: workflow?.id ?? null,
    agentRunId: agent?.id ?? null,
    parentEventId: input.parentEventId ?? null
  };
}

function operationForEvent(event: LedgerEvent): NodeInteraction["operation"] {
  if (event.type === "node.inspected") return event.data.tool === "Grep" || event.data.tool === "Glob" ? "search" : "read";
  if (event.type === "file.changed") return event.data.tool === "Write" ? "create" : "edit";
  if (event.type === "node.executed" || event.type === "test.completed" || event.type === "tool.completed") return "execute";
  return "reference";
}

function roleForEvent(event: LedgerEvent): NodeDeliveryRole {
  if (event.type === "file.changed") return "changed";
  if (event.type === "node.executed" || event.type === "test.completed") return "executed";
  return "touched";
}

function interactionReason(event: LedgerEvent): string {
  if (event.type === "node.inspected") return `${String(event.data.tool ?? "tool")} inspected node`;
  if (event.type === "file.changed") return `${String(event.data.tool ?? "agent")} changed node`;
  if (event.type === "node.executed") return `${String(event.data.stage ?? "runtime")} execution observed`;
  if (event.type === "test.completed") return `${String(event.data.stage ?? "test")} test ${event.status}`;
  return `${event.type} referenced node`;
}

function addPrompt(cycle: PromptCycleRecord, event: LedgerEvent): void {
  const text = stringValue(event.data.prompt) ?? "Nested agent prompt";
  if (cycle.prompts.some((prompt) => prompt.id === event.promptId || (prompt.text === text && prompt.status === "active"))) return;
  cycle.prompts.push({
    id: event.promptId ?? lifecycleId("prompt"),
    parentPromptId: stringValue(event.data.parentPromptId) ?? cycle.prompts.at(-1)?.id ?? null,
    agentRunId: event.agentRunId,
    workflowRunId: event.workflowRunId,
    kind: event.data.nested === true ? "agent" : "user",
    text,
    startedAt: event.timestamp,
    stoppedAt: null,
    status: "active",
    deliveredNodeIds: []
  });
}

function addOrUpdateAgent(cycle: PromptCycleRecord, event: LedgerEvent): void {
  const externalAgentId = stringValue(event.data.agentId) ?? stringValue(event.data.laneId);
  let agent = cycle.agents.find((candidate) => candidate.externalAgentId === externalAgentId && externalAgentId !== null);
  if (!agent) {
    agent = {
      id: lifecycleId("agent"),
      externalAgentId,
      parentAgentRunId: stringValue(event.data.parentAgentRunId) ?? event.agentRunId ?? cycle.agents[0]?.id ?? null,
      parentPromptId: event.promptId,
      workflowRunId: event.workflowRunId,
      agentType: stringValue(event.data.agentType),
      model: stringValue(event.data.model),
      description: stringValue(event.data.description),
      startedAt: event.timestamp,
      stoppedAt: null,
      status: "active",
      tokenUsage: Number(event.data.totalTokens ?? 0)
    };
    cycle.agents.push(agent);
    const nestedPrompt: PromptLifecycle = {
      id: lifecycleId("prompt"),
      parentPromptId: event.promptId ?? cycle.prompts[0]?.id ?? null,
      agentRunId: agent.id,
      workflowRunId: event.workflowRunId,
      kind: "agent",
      text: agent.description ?? `${agent.agentType ?? "Agent"} task`,
      startedAt: event.timestamp,
      stoppedAt: null,
      status: "active",
      deliveredNodeIds: []
    };
    cycle.prompts.push(nestedPrompt);
  }
  if (event.type === "agent.completed" || event.type === "agent.failed") {
    agent.status = event.type === "agent.failed" ? "failed" : "completed";
    agent.stoppedAt = event.timestamp;
    for (const prompt of cycle.prompts.filter((candidate) => candidate.agentRunId === agent!.id && candidate.status === "active")) {
      prompt.status = event.type === "agent.failed" ? "failed" : "completed";
      prompt.stoppedAt = event.timestamp;
    }
  }
  if (typeof event.data.totalTokens === "number") agent.tokenUsage = Math.max(agent.tokenUsage, event.data.totalTokens);
}

function addOrUpdateWorkflow(cycle: PromptCycleRecord, event: LedgerEvent): void {
  const externalTaskId = stringValue(event.data.taskId) ?? stringValue(event.data.laneId);
  let workflow = cycle.workflows.find((candidate) => candidate.externalTaskId === externalTaskId && externalTaskId !== null)
    ?? (event.workflowRunId ? cycle.workflows.find((candidate) => candidate.id === event.workflowRunId) : undefined);
  if (!workflow) {
    workflow = {
      id: event.workflowRunId ?? lifecycleId("workflow"),
      externalTaskId,
      contractId: null,
      parentWorkflowRunId: stringValue(event.data.parentWorkflowRunId),
      parentAgentRunId: event.agentRunId,
      parentPromptId: event.promptId,
      name: stringValue(event.data.subject) ?? stringValue(event.data.description) ?? "Agent workflow",
      startedAt: event.timestamp,
      stoppedAt: null,
      status: "active",
      expectedSkills: [],
      expectedHooks: [],
      invokedSkills: [],
      observedHooks: []
    };
    cycle.workflows.push(workflow);
    cycle.prompts.push({
      id: lifecycleId("prompt"),
      parentPromptId: event.promptId ?? cycle.prompts[0]?.id ?? null,
      agentRunId: event.agentRunId,
      workflowRunId: workflow.id,
      kind: "workflow",
      text: workflow.name,
      startedAt: event.timestamp,
      stoppedAt: null,
      status: "active",
      deliveredNodeIds: []
    });
  }
  if (event.type === "workflow.task.stopped") {
    workflow.status = "completed";
    workflow.stoppedAt = event.timestamp;
    for (const prompt of cycle.prompts.filter((candidate) => candidate.workflowRunId === workflow!.id && candidate.status === "active")) {
      prompt.status = "completed";
      prompt.stoppedAt = event.timestamp;
    }
  } else if (event.status === "failed") {
    workflow.status = "failed";
    workflow.stoppedAt = event.timestamp;
  } else {
    workflow.status = "active";
  }
}

function allocateUsage(cycle: PromptCycleRecord, event: LedgerEvent): void {
  const delta = Math.max(0, Number(event.data.deltaTokens ?? 0));
  if (delta === 0) return;
  const unallocated = cycle.interactions.filter((interaction) => interaction.tokenAttribution === "unallocated");
  if (unallocated.length === 0) return;
  let remaining = delta;
  unallocated.forEach((interaction, index) => {
    const share = index === unallocated.length - 1 ? remaining : Math.floor(delta / unallocated.length);
    interaction.tokens += share;
    interaction.tokenAttribution = "allocated";
    remaining -= share;
  });
  const agent = cycle.agents.find((candidate) => candidate.id === event.agentRunId) ?? cycle.agents[0];
  if (agent) agent.tokenUsage += delta;
}

export function projectSessionEvent(root: string, event: LedgerEvent): void {
  if (!event.sessionId || !event.cycleId) return;
  const sessions = readSessions(root);
  const session = sessions.find((candidate) => candidate.id === event.sessionId);
  const cycle = session?.cycles.find((candidate) => candidate.id === event.cycleId);
  if (!session || !cycle) return;

  if (event.type === "agent.prompted") addPrompt(cycle, event);
  if (["agent.spawned", "agent.completed", "agent.failed"].includes(event.type)) addOrUpdateAgent(cycle, event);
  if (event.type.startsWith("workflow.task.")) addOrUpdateWorkflow(cycle, event);

  if (event.type === "skill.invoked" || event.type === "skill.failed") {
    const skill = stringValue(event.data.skill) ?? stringValue(event.data.name) ?? "unknown-skill";
    const invocation: SkillInvocationRecord = {
      id: lifecycleId("skill"),
      skill,
      agentRunId: event.agentRunId,
      workflowRunId: event.workflowRunId,
      promptId: event.promptId,
      invokedAt: event.timestamp,
      status: event.type === "skill.failed" ? "failed" : "completed",
      evidenceEventId: event.id
    };
    cycle.skills.push(invocation);
    for (const workflow of cycle.workflows.filter((item) => !event.workflowRunId || item.id === event.workflowRunId || item.contractId !== null)) {
      workflow.invokedSkills = unique([...workflow.invokedSkills, skill]);
    }
  }

  if (event.type === "hook.invoked") {
    const hook = stringValue(event.data.hook) ?? "unknown-hook";
    const tool = stringValue(event.data.tool);
    const observedNames = tool ? [hook, `${hook}:${tool}`] : [hook];
    const invocation: HookInvocationRecord = {
      id: lifecycleId("hook"),
      hook,
      agentRunId: event.agentRunId,
      invokedAt: event.timestamp,
      status: event.status === "failed" ? "failed" : "observed",
      evidenceEventId: event.id
    };
    cycle.hooks.push(invocation);
    for (const workflow of cycle.workflows) workflow.observedHooks = unique([...workflow.observedHooks, ...observedNames]);
  }

  if (event.type === "usage.sampled") allocateUsage(cycle, event);

  if (event.nodeIds.length > 0 && ["node.inspected", "file.changed", "node.executed", "test.completed", "tool.completed", "tool.failed", "diagnosis.recorded"].includes(event.type)) {
    for (const nodeId of event.nodeIds) {
      cycle.interactions.push({
        id: lifecycleId("interaction"),
        nodeId,
        eventId: event.id,
        promptId: event.promptId,
        workflowRunId: event.workflowRunId,
        agentRunId: event.agentRunId,
        operation: operationForEvent(event),
        role: roleForEvent(event),
        confidence: event.data.inferred === true ? "inferred" : "observed",
        reason: interactionReason(event),
        observedAt: event.timestamp,
        tokens: 0,
        tokenAttribution: "unallocated"
      });
    }
  }
  writeSessions(root, sessions);
}

function baselineManifest(root: string, cycleId: string): BaselineManifest {
  const directory = path.join(statePaths(root).baselines, cycleId);
  const file = path.join(directory, "manifest.json");
  if (!fs.existsSync(file)) return { cycleId, files: [] };
  return JSON.parse(fs.readFileSync(file, "utf8")) as BaselineManifest;
}

export function captureFileBaseline(root: string, cycleId: string, absoluteFile: string): void {
  const relative = path.relative(root, absoluteFile).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative) || relative.startsWith(".proof-replay/")) return;
  const paths = statePaths(root);
  const directory = path.join(paths.baselines, cycleId);
  fs.mkdirSync(directory, { recursive: true });
  const manifest = baselineManifest(root, cycleId);
  if (manifest.files.some((entry) => entry.file === relative)) return;
  const snapshot = `${createHash("sha1").update(relative).digest("hex")}.source`;
  const existed = fs.existsSync(absoluteFile) && fs.statSync(absoluteFile).isFile();
  if (existed) fs.copyFileSync(absoluteFile, path.join(directory, snapshot));
  manifest.files.push({ file: relative, snapshot, existed });
  writeJsonAtomic(path.join(directory, "manifest.json"), manifest);
}

function normalizedDiff(root: string, cycleId: string): string {
  const manifest = baselineManifest(root, cycleId);
  const directory = path.join(statePaths(root).baselines, cycleId);
  const parts: string[] = [];
  for (const entry of manifest.files) {
    const before = entry.existed ? path.join(directory, entry.snapshot) : "/dev/null";
    const afterAbsolute = path.join(root, entry.file);
    const after = fs.existsSync(afterAbsolute) ? afterAbsolute : "/dev/null";
    const result = spawnSync("git", ["diff", "--no-index", "--no-ext-diff", "--unified=3", "--", before, after], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 2_000_000
    });
    if (![0, 1].includes(result.status ?? 2) || !result.stdout.trim()) continue;
    const lines = result.stdout.trim().split("\n").filter((line) => !line.startsWith("diff --git ") && !line.startsWith("index "));
    const rewritten = lines.map((line) => line.startsWith("--- ") ? `--- ${entry.existed ? `a/${entry.file}` : "/dev/null"}` : line.startsWith("+++ ") ? `+++ ${after === "/dev/null" ? "/dev/null" : `b/${entry.file}`}` : line);
    parts.push(rewritten.join("\n"));
  }
  return parts.join("\n");
}

function repositoryDiffSince(root: string, baseline: RepositorySnapshot): string {
  if (baseline.dirtyFiles.length > 0 || !baseline.head) return "";
  const currentHead = git(root, ["rev-parse", "HEAD"]);
  const committed = currentHead && currentHead !== baseline.head ? git(root, ["diff", "--no-ext-diff", "--unified=3", baseline.head, currentHead, "--"]) ?? "" : "";
  const working = git(root, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--"]) ?? "";
  const combined = [committed, working].filter(Boolean).join("\n");
  return combined.length > 240_000 ? `${combined.slice(0, 240_000)}\n… diff truncated by Proof & Replay` : combined;
}

function graphForRoot(root: string): RepositoryGraph | null {
  const file = statePaths(root).graph;
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as RepositoryGraph : null;
}

function diffRanges(diff: string): Map<string, Array<{ start: number; end: number }>> {
  const result = new Map<string, Array<{ start: number; end: number }>>();
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6).trim();
      if (!result.has(file)) result.set(file, []);
      continue;
    }
    if (!file || !line.startsWith("@@")) continue;
    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = Math.max(1, Number(match[2] ?? 1));
    result.get(file)!.push({ start, end: start + count - 1 });
  }
  return result;
}

function nodeEndLine(root: string, node: GraphNode): number {
  const file = path.join(root, node.file);
  if (!fs.existsSync(file) || node.end <= node.start) return node.line;
  const source = fs.readFileSync(file, "utf8");
  return source.slice(0, Math.min(source.length, node.end)).split("\n").length;
}

function changedNodesFromDiff(root: string, diff: string, graph: RepositoryGraph | null, fallback: readonly string[]): string[] {
  if (!graph || !diff.trim()) return diff.trim() ? unique(fallback) : [];
  const ranges = diffRanges(diff);
  const changed = new Set<string>();
  for (const [file, intervals] of ranges) {
    for (const node of graph.nodes.filter((candidate) => candidate.file === file)) {
      if (node.kind === "file" || intervals.length === 0 || intervals.some((interval) => node.line <= interval.end && nodeEndLine(root, node) >= interval.start)) changed.add(node.id);
    }
  }
  // Deleted files are absent from the freshly scanned graph. Preserve the
  // pre-mutation node identities recorded by the hook so deletion delivery is
  // not mistaken for a reverted edit.
  if (changed.size === 0 || /^\+\+\+ \/dev\/null$/m.test(diff)) {
    for (const nodeId of fallback) changed.add(nodeId);
  }
  return [...changed];
}

export function mapDiffToNodes(root: string, diff: string, fallback: readonly string[] = []): string[] {
  return changedNodesFromDiff(root, diff, graphForRoot(root), fallback);
}

function deliveryReferences(graph: RepositoryGraph | null, changedIds: readonly string[], interactedIds: ReadonlySet<string>): { nodeIds: string[]; edgeIds: string[] } {
  if (!graph) return { nodeIds: [], edgeIds: [] };
  const changed = new Set(changedIds);
  const references = new Set<string>();
  const edges = new Set<string>();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    const sourceChanged = changed.has(edge.source);
    const targetChanged = changed.has(edge.target);
    if (!sourceChanged && !targetChanged) continue;
    const otherId = sourceChanged ? edge.target : edge.source;
    const other = byId.get(otherId);
    if (!other) continue;
    const structuralParent = edge.kind === "contains" && targetChanged;
    const semanticReference = ["handles", "uses-data"].includes(edge.kind)
      || (["calls", "imports", "requests"].includes(edge.kind) && interactedIds.has(otherId));
    const verificationReference = other.kind === "test" && interactedIds.has(otherId);
    if (structuralParent || semanticReference || verificationReference) {
      references.add(otherId);
      edges.add(edge.id);
    }
  }
  return { nodeIds: [...references].slice(0, 80), edgeIds: [...edges].slice(0, 120) };
}

function complianceFor(cycle: PromptCycleRecord): DeliverySnapshot["compliance"] {
  const expectedSkills = unique(cycle.workflows.flatMap((workflow) => workflow.expectedSkills));
  const expectedHooks = unique(cycle.workflows.flatMap((workflow) => workflow.expectedHooks));
  const invokedSkills = unique(cycle.skills.map((skill) => skill.skill));
  const observedHooks = unique([...cycle.hooks.map((hook) => hook.hook), ...cycle.workflows.flatMap((workflow) => workflow.observedHooks)]);
  return {
    expectedSkills,
    invokedSkills,
    missingSkills: expectedSkills.filter((skill) => !invokedSkills.includes(skill)),
    expectedHooks,
    observedHooks,
    missingHooks: expectedHooks.filter((hook) => !observedHooks.includes(hook))
  };
}

export function finalizeSessionCycle(root: string, runId: string, events: readonly LedgerEvent[], status: PromptCycleRecord["status"]): DeliverySnapshot | null {
  const sessions = readSessions(root);
  const session = sessions.find((candidate) => candidate.cycles.some((cycle) => cycle.runId === runId));
  const cycle = session?.cycles.find((candidate) => candidate.runId === runId);
  if (!session || !cycle) return null;
  const graph = graphForRoot(root);
  const baselineDiff = normalizedDiff(root, cycle.id);
  const legacyDiff = [...events].reverse().find((event) => event.type === "file.changed" && typeof event.data.diff === "string")?.data.diff;
  const diff = baselineDiff || repositoryDiffSince(root, cycle.baseline) || (typeof legacyDiff === "string" ? legacyDiff : "");
  const intermediateChanged = unique(cycle.interactions.filter((interaction) => interaction.role === "changed").map((interaction) => interaction.nodeId));
  const changedNodeIds = changedNodesFromDiff(root, diff, graph, intermediateChanged);
  const touchedNodeIds = unique(cycle.interactions.map((interaction) => interaction.nodeId));
  const interacted = new Set(touchedNodeIds);
  const references = deliveryReferences(graph, changedNodeIds, interacted);
  const lastChangeSeq = Math.max(0, ...events.filter((event) => event.type === "file.changed").map((event) => event.seq));
  const executedAfterChange = new Set(events.filter((event) => event.seq > lastChangeSeq && event.type === "node.executed").flatMap((event) => event.nodeIds));
  const verifiedNodeIds = changedNodeIds.filter((id) => executedAfterChange.has(id));
  const revertedNodeIds = intermediateChanged.filter((id) => !changedNodeIds.includes(id));
  const referenceNodeIds = references.nodeIds.filter((id) => !changedNodeIds.includes(id));
  const unrelatedTouchedNodeIds = touchedNodeIds.filter((id) => !changedNodeIds.includes(id) && !referenceNodeIds.includes(id) && !verifiedNodeIds.includes(id));
  const tokenUsage = events.filter((event) => event.type === "usage.sampled").reduce((sum, event) => sum + Math.max(0, Number(event.data.deltaTokens ?? 0)), 0);
  const allocatedTokens = cycle.interactions.reduce((sum, interaction) => sum + interaction.tokens, 0);
  const finalState = repositorySnapshot(root);
  const compliance = complianceFor(cycle);
  const pathNodeIds = unique([...changedNodeIds, ...verifiedNodeIds, ...referenceNodeIds]);
  const pathNodeSet = new Set(pathNodeIds);
  const contributingInteractions = cycle.interactions.filter((interaction) => pathNodeSet.has(interaction.nodeId));
  const contributingEventIds = new Set(contributingInteractions.map((interaction) => interaction.eventId));
  const contributingAgentIds = new Set(contributingInteractions.map((interaction) => interaction.agentRunId).filter((id): id is string => id !== null));
  const pathEventIds = unique(events.filter((event) => contributingEventIds.has(event.id)
    || ["task.started", "agent.prompted", "agent.stopped", "verification.passed", "task.completed"].includes(event.type)
    || (event.agentRunId !== null && contributingAgentIds.has(event.agentRunId) && (event.type.startsWith("agent.") || event.type.startsWith("workflow."))))
    .map((event) => event.id));
  const delivery: DeliverySnapshot = {
    capturedAt: new Date().toISOString(),
    baseline: cycle.baseline,
    finalState,
    diff,
    touchedNodeIds,
    changedNodeIds,
    deliveredNodeIds: changedNodeIds,
    verifiedNodeIds,
    referenceNodeIds,
    revertedNodeIds,
    unrelatedTouchedNodeIds,
    pathNodeIds,
    pathEdgeIds: references.edgeIds,
    pathEventIds,
    tokenUsage,
    allocatedTokens,
    unallocatedTokens: Math.max(0, tokenUsage - allocatedTokens),
    compliance
  };

  const delivered = new Set(changedNodeIds);
  const verified = new Set(verifiedNodeIds);
  const reference = new Set(referenceNodeIds);
  const reverted = new Set(revertedNodeIds);
  const unrelated = new Set(unrelatedTouchedNodeIds);
  for (const interaction of cycle.interactions) {
    if (verified.has(interaction.nodeId) && interaction.operation === "execute") interaction.role = "verified";
    else if (delivered.has(interaction.nodeId) && interaction.role === "changed") interaction.role = "delivered";
    else if (reverted.has(interaction.nodeId) && interaction.role === "changed") interaction.role = "reverted";
    else if (reference.has(interaction.nodeId)) interaction.role = "delivery-reference";
    else if (unrelated.has(interaction.nodeId)) interaction.role = "unrelated-touch";
  }
  for (const nodeId of referenceNodeIds.filter((id) => !cycle.interactions.some((interaction) => interaction.nodeId === id))) {
    cycle.interactions.push({
      id: lifecycleId("interaction"), nodeId, eventId: events.at(-1)?.id ?? "derived", promptId: cycle.prompts[0]?.id ?? null,
      workflowRunId: null, agentRunId: cycle.agents[0]?.id ?? null, operation: "reference", role: "delivery-reference",
      confidence: "derived", reason: "Required by a delivered node relationship", observedAt: delivery.capturedAt,
      tokens: 0, tokenAttribution: "inferred"
    });
  }
  for (const prompt of cycle.prompts) prompt.deliveredNodeIds = unique(cycle.interactions.filter((interaction) => interaction.promptId === prompt.id && delivered.has(interaction.nodeId)).map((interaction) => interaction.nodeId));
  cycle.delivery = delivery;
  cycle.status = status;
  cycle.stoppedAt = delivery.capturedAt;
  for (const prompt of cycle.prompts.filter((item) => item.status === "active")) { prompt.status = "completed"; prompt.stoppedAt = delivery.capturedAt; }
  for (const agent of cycle.agents.filter((item) => item.status === "active")) { agent.status = "completed"; agent.stoppedAt = delivery.capturedAt; }
  for (const workflow of cycle.workflows) {
    if (workflow.status === "active") { workflow.status = "completed"; workflow.stoppedAt = delivery.capturedAt; }
    if (workflow.status === "planned" && (workflow.expectedSkills.length > 0 || workflow.expectedHooks.length > 0)) {
      const missingSkill = workflow.expectedSkills.some((skill) => !workflow.invokedSkills.includes(skill));
      const missingHook = workflow.expectedHooks.some((hook) => !workflow.observedHooks.includes(hook));
      workflow.status = missingSkill || missingHook ? "missed" : "completed";
      workflow.stoppedAt = delivery.capturedAt;
    }
  }
  writeSessions(root, sessions);
  return delivery;
}

export function closeSession(root: string, sessionId: string, status: SessionStatus): void {
  const sessions = readSessions(root);
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return;
  session.status = status;
  session.endedAt = new Date().toISOString();
  writeSessions(root, sessions);
}

export function reconcileStoppedCycles(root: string, runs: readonly ProofRun[], events: readonly LedgerEvent[]): string[] {
  const sessions = readSessions(root);
  const finalizedRunIds: string[] = [];
  for (const session of sessions) {
    const latestCycle = session.cycles.at(-1);
    for (const cycle of session.cycles) {
      if (cycle.delivery || cycle.status !== "active") continue;
      const run = runs.find((candidate) => candidate.id === cycle.runId);
      const runEvents = events.filter((event) => event.runId === cycle.runId);
      const stopped = runEvents.some((event) => event.type === "agent.stopped");
      const superseded = latestCycle?.id !== cycle.id;
      const explicitlyClosed = run?.status !== "running";
      if (!stopped || (!superseded && !explicitlyClosed)) continue;
      finalizeSessionCycle(root, cycle.runId, runEvents, run?.status === "blocked" ? "blocked" : run?.status === "detached" ? "detached" : "stopped");
      finalizedRunIds.push(cycle.runId);
    }
  }
  return finalizedRunIds;
}

export function migrateLegacySessions(root: string, runs: readonly ProofRun[], events: readonly LedgerEvent[]): SessionRecord[] {
  const existing = readSessions(root);
  if (existing.length > 0 || runs.length === 0) return existing;
  const sessions: SessionRecord[] = runs.map((run) => {
    const runEvents = events.filter((event) => event.runId === run.id);
    const externalSessionId = runEvents.map((event) => stringValue(event.data.sessionId)).find((value) => value !== null) ?? null;
    const now = run.createdAt;
    const promptId = lifecycleId("prompt");
    const agentId = lifecycleId("agent");
    const cycleId = run.cycleId || lifecycleId("cycle");
    run.sessionId ||= lifecycleId("session");
    run.cycleId = cycleId;
    return {
      schemaVersion: 1,
      id: run.sessionId,
      provider: externalSessionId ? "claude" : "unknown",
      externalSessionId,
      repositoryRoot: root,
      startedAt: run.createdAt,
      endedAt: run.completedAt,
      status: run.status === "running" ? "active" : run.status === "detached" ? "detached" : "completed",
      cycles: [{
        id: cycleId, runId: run.id, ordinal: 1, parentCycleId: null, prompt: run.prompt, startedAt: now, stoppedAt: run.completedAt,
        status: run.status === "running" ? "active" : run.status === "blocked" ? "blocked" : run.status === "detached" ? "detached" : "completed",
        baseline: repositorySnapshot(root),
        prompts: [{ id: promptId, parentPromptId: null, agentRunId: agentId, workflowRunId: null, kind: "user", text: run.prompt, startedAt: now, stoppedAt: run.completedAt, status: run.status === "running" ? "active" : "completed", deliveredNodeIds: [] }],
        workflows: [],
        agents: [{ id: agentId, externalAgentId: externalSessionId, parentAgentRunId: null, parentPromptId: promptId, workflowRunId: null, agentType: "main", model: null, description: "Migrated agent", startedAt: now, stoppedAt: run.completedAt, status: run.status === "running" ? "active" : "completed", tokenUsage: 0 }],
        skills: [], hooks: [], interactions: [], delivery: null
      }]
    };
  });
  writeSessions(root, sessions);
  for (const event of events) {
    const run = runs.find((candidate) => candidate.id === event.runId);
    if (!run) continue;
    event.sessionId ??= run.sessionId;
    event.cycleId ??= run.cycleId;
    event.promptId ??= sessions.find((session) => session.id === run.sessionId)?.cycles[0]?.prompts[0]?.id ?? null;
    event.agentRunId ??= sessions.find((session) => session.id === run.sessionId)?.cycles[0]?.agents[0]?.id ?? null;
    event.workflowRunId ??= null;
    event.parentEventId ??= null;
    projectSessionEvent(root, event);
  }
  for (const run of runs.filter((candidate) => candidate.status !== "running")) {
    const status: PromptCycleRecord["status"] = run.status === "blocked" ? "blocked" : run.status === "detached" ? "detached" : run.status === "stopped" ? "stopped" : "completed";
    finalizeSessionCycle(root, run.id, events.filter((event) => event.runId === run.id), status);
  }
  return readSessions(root);
}
