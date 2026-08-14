import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LedgerEvent, ProofCheck, ProofReplayConfig, ProofResult, ProofRun, RepositoryGraph, RouteDefinition, SessionRecord, TokenUsage } from "../types.js";
import { GraphCanvas, lifecycleEvidence, lifecycleNodeId } from "./components/GraphCanvas.js";
import type { DisplayNode, GraphMode, LifecycleKind } from "./components/GraphCanvas.js";
import { Badge, Button, Panel, PanelHeader, PlayIcon, Select } from "./components/primitives.js";

const EMPTY_GRAPH: RepositoryGraph = { schemaVersion: 1, generatedAt: "", root: "", nodes: [], edges: [], stats: { files: 0, functions: 0, tests: 0, edges: 0, projects: 0, routes: 0 } };
const EMPTY_CONFIG: ProofReplayConfig = {
  schemaVersion: 1,
  sourceExtensions: [],
  exclude: [],
  proofPolicy: { requireReproduction: true, requireChange: true, requirePassingVerification: true, requireExecutedChangedNode: true },
  tokenMonitoring: { sessionWarningTokens: 200_000, turnSpikeTokens: 50_000 },
  workflowContracts: []
};
const EMPTY_CHECKS: Array<Pick<ProofCheck, "id" | "label" | "passed">> = [
  { id: "reproduction", label: "Original failure reproduced", passed: false },
  { id: "change", label: "Code change recorded after reproduction", passed: false },
  { id: "passing-verification", label: "Verification passed after the change", passed: false },
  { id: "changed-node-executed", label: "Changed code executed during verification", passed: false }
];
const EVENT_LABELS: Readonly<Record<string, string>> = {
  "task.started": "Task started", "agent.prompted": "Prompt submitted", "node.inspected": "Code inspected",
  "tool.completed": "Command completed", "tool.failed": "Command failed", "agent.stopped": "Agent turn stopped",
  "test.started": "Tests started", "node.executed": "Code path executed", "test.completed": "Tests completed",
  "diagnosis.recorded": "Cause recorded", "file.changed": "Code changed", "verification.passed": "Proof verified",
  "verification.failed": "Proof rejected", "task.completed": "Task completed", "task.blocked": "Completion blocked",
  "usage.sampled": "Token usage sampled", "agent.spawned": "Agent spawned", "agent.completed": "Agent completed",
  "agent.failed": "Agent failed", "agent.output": "Agent output", "workflow.task.created": "Workflow task created",
  "workflow.task.updated": "Workflow task updated", "workflow.task.stopped": "Workflow task stopped",
  "hook.invoked": "Hook invoked", "skill.invoked": "Skill invoked", "skill.failed": "Skill failed", "tool.prepared": "Mutation baseline captured"
};

interface InspectorState {
  title: string;
  detail: string;
  values: ReadonlyArray<readonly [string, string]>;
  diff?: string | undefined;
}

interface TokenAlarm {
  title: string;
  detail: string;
}

const DEFAULT_INSPECTOR: InspectorState = {
  title: "Select a node",
  detail: "Choose a project, route, file, function, or scenario step to inspect its recorded evidence and inferred relationships.",
  values: []
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
  return response.json() as Promise<T>;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function truncate(value: unknown, limit: number): string {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function eventDetail(event: LedgerEvent): string {
  if (event.type === "usage.sampled" && typeof event.data.totalTokens === "number") return `${formatTokens(event.data.totalTokens)} tokens processed`;
  if (typeof event.data.summary === "string") return event.data.summary;
  if (typeof event.data.stage === "string") return `${event.data.stage} · ${event.status}`;
  if (Array.isArray(event.data.files)) return event.data.files.map(String).join(", ");
  if (typeof event.data.prompt === "string") return event.data.prompt;
  if (typeof event.data.command === "string") return event.data.command;
  return event.status;
}

function proofTone(run: ProofRun | null): "success" | "danger" | "neutral" {
  if (run?.status === "completed") return "success";
  if (run?.status === "blocked") return "danger";
  return "neutral";
}

function proofLabel(run: ProofRun | null): string {
  if (run?.status === "completed") return "Verified";
  if (run?.status === "blocked") return "Blocked";
  return "Open";
}

function progressiveChecks(events: readonly LedgerEvent[]): Array<Pick<ProofCheck, "id" | "label" | "passed">> {
  const reproduction = events.find((event) => event.type === "test.completed" && event.status === "failed" && event.data.stage === "reproduce");
  const change = events.find((event) => event.type === "file.changed" && event.seq > (reproduction?.seq ?? Number.MAX_SAFE_INTEGER));
  const changedNodeIds = new Set(change?.nodeIds ?? []);
  const execution = events.find((event) => event.type === "node.executed" && event.seq > (change?.seq ?? Number.MAX_SAFE_INTEGER) && event.nodeIds.some((nodeId) => changedNodeIds.has(nodeId)));
  const verification = events.find((event) => event.type === "test.completed" && event.status === "passed" && event.data.stage === "verify" && event.seq > (change?.seq ?? Number.MAX_SAFE_INTEGER));
  return EMPTY_CHECKS.map((check) => ({ ...check, passed: check.id === "reproduction" ? Boolean(reproduction) : check.id === "change" ? Boolean(change) : check.id === "passing-verification" ? Boolean(verification) : Boolean(execution) }));
}

function tokenUsage(events: readonly LedgerEvent[]): (TokenUsage & { deltaTokens: number; warning: boolean }) | null {
  const event = [...events].reverse().find((candidate) => candidate.type === "usage.sampled");
  if (!event || typeof event.data.totalTokens !== "number") return null;
  return {
    inputTokens: Number(event.data.inputTokens ?? 0),
    outputTokens: Number(event.data.outputTokens ?? 0),
    cacheCreationInputTokens: Number(event.data.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens: Number(event.data.cacheReadInputTokens ?? 0),
    totalTokens: event.data.totalTokens,
    observedAt: String(event.data.observedAt ?? event.timestamp),
    source: event.data.source === "tool-response" ? "tool-response" : "claude-transcript",
    deltaTokens: Number(event.data.deltaTokens ?? 0),
    warning: event.data.warning === true
  };
}

function eventHasRepositoryContext(event: LedgerEvent, graph: RepositoryGraph): boolean {
  if (event.nodeIds.length > 0) return true;
  const command = typeof event.data.command === "string" ? event.data.command : "";
  if (!command) return false;
  if (graph.root && command.includes(graph.root)) return true;
  return (graph.architecture?.projects ?? []).some((project) => project.path !== "." && command.includes(project.path));
}

function permissionState(): NotificationPermission | "unsupported" {
  return "Notification" in window ? Notification.permission : "unsupported";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function alertKey(runId: string, usage: TokenUsage & { deltaTokens: number }, config: ProofReplayConfig): string {
  if (usage.deltaTokens >= config.tokenMonitoring.turnSpikeTokens) return `${runId}:spike:${usage.observedAt}`;
  const level = Math.max(1, Math.floor(usage.totalTokens / config.tokenMonitoring.sessionWarningTokens));
  return `${runId}:session:${level}`;
}

export function DashboardApp(): JSX.Element {
  const [graph, setGraph] = useState<RepositoryGraph>(EMPTY_GRAPH);
  const [config, setConfig] = useState<ProofReplayConfig>(EMPTY_CONFIG);
  const [runs, setRuns] = useState<ProofRun[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [proof, setProof] = useState<ProofResult | null>(null);
  const [mode, setMode] = useState<GraphMode>("model");
  const [traceView, setTraceView] = useState<"exploration" | "delivery">("exploration");
  const [replayCount, setReplayCount] = useState<number | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [routeQuery, setRouteQuery] = useState("");
  const [inspector, setInspector] = useState<InspectorState>(DEFAULT_INSPECTOR);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(permissionState);
  const [tokenAlarm, setTokenAlarm] = useState<TokenAlarm | null>(null);
  const [showNavigator, setShowNavigator] = useState(() => window.innerWidth > 780);
  const [showDetails, setShowDetails] = useState(() => window.innerWidth > 780);
  const [expandedSessionIds, setExpandedSessionIds] = useState<Set<string>>(() => new Set());
  const [expandedCycleIds, setExpandedCycleIds] = useState<Set<string>>(() => new Set());
  const [pendingLifecycleSelection, setPendingLifecycleSelection] = useState<{ runId: string; kind: LifecycleKind; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const notifiedKey = useRef<string | null>(null);

  const run = useMemo(() => runs.find((candidate) => candidate.id === selectedRunId) ?? null, [runs, selectedRunId]);
  const session = useMemo(() => sessions.find((candidate) => candidate.id === run?.sessionId) ?? sessions.find((candidate) => candidate.cycles.some((cycle) => cycle.runId === selectedRunId)) ?? null, [run?.sessionId, selectedRunId, sessions]);
  const cycle = useMemo(() => session?.cycles.find((candidate) => candidate.runId === selectedRunId) ?? null, [selectedRunId, session]);
  const delivery = cycle?.delivery ?? null;
  const visibleEvents = replayCount === null ? events : events.slice(0, replayCount);
  const replaying = replayCount !== null;
  const replayCompleted = visibleEvents.some((event) => event.type === "task.completed");
  const replayBlocked = visibleEvents.some((event) => event.type === "task.blocked");
  const displayedRun = replaying && run ? { ...run, status: replayCompleted ? "completed" as const : replayBlocked ? "blocked" as const : "running" as const } : run;
  const checks = replaying ? progressiveChecks(visibleEvents) : proof?.checks ?? EMPTY_CHECKS;
  const passedChecks = checks.filter((check) => check.passed).length;
  const usage = useMemo(() => tokenUsage(visibleEvents), [visibleEvents]);
  const projects = graph.architecture?.projects ?? [];
  const routes = graph.architecture?.routes ?? [];
  const filteredRoutes = routes.filter((route) => (!selectedProjectId || route.projectId === selectedProjectId) && (!routeQuery || `${route.method} ${route.path} ${route.file}`.toLowerCase().includes(routeQuery.toLowerCase())));
  const warningThreshold = config.tokenMonitoring.sessionWarningTokens;
  const usagePercent = usage ? Math.min(100, (usage.totalTokens / warningThreshold) * 100) : 0;

  useEffect(() => {
    if (session) setExpandedSessionIds((current) => current.has(session.id) ? current : new Set([...current, session.id]));
    if (cycle) setExpandedCycleIds((current) => current.has(cycle.id) ? current : new Set([...current, cycle.id]));
  }, [cycle, session]);

  const toggleSession = (sessionId: string): void => {
    setExpandedSessionIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId);
      return next;
    });
  };

  const toggleCycle = (cycleId: string): void => {
    setExpandedCycleIds((current) => {
      const next = new Set(current);
      if (next.has(cycleId)) next.delete(cycleId); else next.add(cycleId);
      return next;
    });
  };

  useEffect(() => {
    setTraceView(delivery ? "delivery" : "exploration");
  }, [delivery, selectedRunId]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchJson<RepositoryGraph>("/api/graph"), fetchJson<ProofRun[]>("/api/runs"), fetchJson<ProofReplayConfig>("/api/config"), fetchJson<SessionRecord[]>("/api/sessions")]).then(([nextGraph, nextRuns, nextConfig, nextSessions]) => {
      if (cancelled) return;
      setGraph(nextGraph);
      setRuns(nextRuns);
      setConfig(nextConfig);
      setSessions(nextSessions);
      setSelectedRunId((current) => current || nextRuns[0]?.id || "");
    }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedRunId) { setEvents([]); setProof(null); return; }
    let cancelled = false;
    setReplayCount(null);
    setSelectedNodeId(null);
    setInspector(DEFAULT_INSPECTOR);
    Promise.all([fetchJson<LedgerEvent[]>(`/api/events?runId=${encodeURIComponent(selectedRunId)}`), fetchJson<ProofResult>(`/api/proof?runId=${encodeURIComponent(selectedRunId)}`)]).then(([nextEvents, nextProof]) => {
      if (!cancelled) { setEvents(nextEvents); setProof(nextProof); }
    }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });

    const stream = new EventSource(`/api/stream?runId=${encodeURIComponent(selectedRunId)}`);
    const onProofEvent = (message: MessageEvent<string>): void => {
      const event = JSON.parse(message.data) as LedgerEvent;
      setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event]);
      const requests: [Promise<ProofRun[]>, Promise<ProofResult>, Promise<RepositoryGraph> | null, Promise<SessionRecord[]>] = [
        fetchJson<ProofRun[]>("/api/runs"),
        fetchJson<ProofResult>(`/api/proof?runId=${encodeURIComponent(selectedRunId)}`),
        event.type === "file.changed" ? fetchJson<RepositoryGraph>("/api/graph") : null,
        fetchJson<SessionRecord[]>("/api/sessions")
      ];
      void Promise.all([requests[0], requests[1], requests[2] ?? Promise.resolve(null), requests[3]]).then(([nextRuns, nextProof, nextGraph, nextSessions]) => {
        if (cancelled) return;
        setRuns(nextRuns);
        setProof(nextProof);
        setSessions(nextSessions);
        if (nextGraph) setGraph(nextGraph);
      });
    };
    stream.addEventListener("proof-event", onProofEvent as EventListener);
    return () => { cancelled = true; stream.removeEventListener("proof-event", onProofEvent as EventListener); stream.close(); };
  }, [selectedRunId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void Promise.all([fetchJson<ProofRun[]>("/api/runs"), fetchJson<SessionRecord[]>("/api/sessions")]).then(([nextRuns, nextSessions]) => {
        setRuns(nextRuns);
        setSessions(nextSessions);
        if (!run || run.status === "running") return;
        if (session?.cycles.at(-1)?.runId !== selectedRunId) return;
        const currentSession = nextSessions.find((candidate) => candidate.id === run.sessionId);
        const latestCycle = currentSession?.cycles.at(-1);
        if (latestCycle && latestCycle.runId !== selectedRunId) setSelectedRunId(latestCycle.runId);
      }).catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [run, selectedRunId, session]);

  useEffect(() => {
    if (replayCount === null) return;
    if (replayCount >= events.length) {
      const completion = window.setTimeout(() => setReplayCount(null), 500);
      return () => window.clearTimeout(completion);
    }
    const timer = window.setTimeout(() => setReplayCount((current) => current === null ? null : current + 1), 400);
    return () => window.clearTimeout(timer);
  }, [events.length, replayCount]);

  const deliverTokenAlert = useCallback((currentRun: ProofRun, currentUsage: NonNullable<typeof usage>, test = false): void => {
    const key = test ? `${currentRun.id}:test:${Date.now()}` : alertKey(currentRun.id, currentUsage, config);
    if (!test && (notifiedKey.current === key || window.localStorage.getItem(`proof-replay:alert:${key}`) === "true")) return;
    const detail = test
      ? "Token alerts are connected. Future threshold crossings will appear here and in browser notifications."
      : `${formatTokens(currentUsage.totalTokens)} tokens processed; ${formatTokens(currentUsage.deltaTokens)} added in the latest sample.`;
    setTokenAlarm({ title: test ? "Token alert test" : "High token usage detected", detail });
    try {
      new Notification(test ? "Proof & Replay alert test" : "Proof & Replay token alert", {
        body: detail,
        tag: test ? `proof-replay:test:${Date.now()}` : `proof-replay:${key}`,
        requireInteraction: !test
      });
    } catch {
      // The in-app alarm remains visible when the operating system suppresses native notifications.
    }
    notifiedKey.current = key;
    if (!test) window.localStorage.setItem(`proof-replay:alert:${key}`, "true");
  }, [config]);

  useEffect(() => {
    if (!run || !usage?.warning || notificationPermission !== "granted") return;
    deliverTokenAlert(run, usage);
  }, [deliverTokenAlert, notificationPermission, run, usage]);

  const inspectNode = useCallback((node: DisplayNode): void => {
    setSelectedNodeId(node.id);
    if (window.innerWidth <= 780) setShowDetails(true);
    const sourceId = typeof node.data?.sourceNodeId === "string" ? node.data.sourceNodeId : node.id;
    const source = graph.nodes.find((candidate) => candidate.id === sourceId);
    const cycleInteractions = cycle?.interactions.filter((interaction) => interaction.nodeId === sourceId) ?? [];
    const cycleRoles = [...new Set(cycleInteractions.map((interaction) => interaction.role))];
    const attributedTokens = cycleInteractions.reduce((sum, interaction) => sum + interaction.tokens, 0);
    const deliveryRole = delivery?.verifiedNodeIds.includes(sourceId) ? "verified delivery"
      : delivery?.deliveredNodeIds.includes(sourceId) ? "delivered change"
        : delivery?.referenceNodeIds.includes(sourceId) ? "delivery reference"
          : delivery?.revertedNodeIds.includes(sourceId) ? "reverted change"
            : delivery?.unrelatedTouchedNodeIds.includes(sourceId) ? "unrelated exploration" : null;
    const incoming = source ? graph.edges.filter((edge) => edge.target === source.id) : [];
    const outgoing = source ? graph.edges.filter((edge) => edge.source === source.id) : [];
    const inference = source && typeof source.data.inference === "string" ? source.data.inference : undefined;
    const confidence = source && typeof source.data.confidence === "string" ? source.data.confidence : undefined;
    const parameters = source ? stringList(source.data.parameters) : [];
    const fields = source ? stringList(source.data.fields) : [];
    const changed = source ? [...visibleEvents].reverse().find((event) => event.type === "file.changed" && (event.nodeIds.includes(source.id) || (Array.isArray(event.data.files) && event.data.files.includes(source.file)))) : undefined;
    const execution = source ? [...visibleEvents].reverse().find((event) => event.type === "node.executed" && event.nodeIds.includes(source.id)) : undefined;
    const executionRows = Array.isArray(execution?.data.executions) ? execution.data.executions as Array<{ nodeId?: unknown; count?: unknown }> : [];
    const executionCount = executionRows.find((item) => item.nodeId === source?.id)?.count;
    const calledFunctions = outgoing.filter((edge) => edge.kind === "calls").slice(0, 6).map((edge) => {
      const target = graph.nodes.find((candidate) => candidate.id === edge.target);
      const args = stringList(edge.data.arguments);
      return `${target?.label ?? edge.target}${args.length > 0 ? `(${args.join(", ")})` : "()"}`;
    });
    const callers = incoming.filter((edge) => edge.kind === "calls").slice(0, 6).map((edge) => graph.nodes.find((candidate) => candidate.id === edge.source)?.label ?? edge.source);
    const models = outgoing.filter((edge) => edge.kind === "uses-data").slice(0, 6).map((edge) => graph.nodes.find((candidate) => candidate.id === edge.target)?.label ?? edge.target);
    const summarizedTouched = stringList(node.data?.touchedNodeIds);
    const summarizedChanged = stringList(node.data?.changedNodeIds);
    const summarizedDelivered = stringList(node.data?.deliveredNodeIds);
    const summarizedVerified = stringList(node.data?.verifiedNodeIds);
    const summarizedEvents = stringList(node.data?.eventIds);
    const summarizedTokens = typeof node.data?.tokens === "number" ? node.data.tokens : 0;
    const summarizedNodeLabels = summarizedTouched.slice(0, 8).map((nodeId) => graph.nodes.find((candidate) => candidate.id === nodeId)?.label ?? nodeId);
    const missingSkills = stringList(node.data?.missingSkills);
    const missingHooks = stringList(node.data?.missingHooks);
    setInspector({
      title: node.label,
      detail: inference ?? (node.subtitle || (node.file ? `${node.file}${node.line ? `:${node.line}` : ""}` : `${node.kicker} evidence node`)),
      values: [
        ["Type", node.kind ?? node.kicker], ["Status", node.status],
        ...(node.file ? [["File", node.file] as const] : []), ...(node.line ? [["Line", String(node.line)] as const] : []),
        ...(confidence ? [["Confidence", confidence] as const] : []), ...(source ? [["Incoming", String(incoming.length)] as const, ["Outgoing", String(outgoing.length)] as const] : []),
        ...(cycleRoles.length > 0 ? [["Cycle roles", cycleRoles.join(" · ")] as const] : []),
        ...(deliveryRole ? [["Delivery role", deliveryRole] as const] : []),
        ...(attributedTokens > 0 ? [["Attributed tokens", formatTokens(attributedTokens)] as const] : []),
        ...(summarizedTokens > 0 ? [["Mapped tokens", formatTokens(summarizedTokens)] as const] : []),
        ...(typeof node.data?.observedTokens === "number" && node.data.observedTokens > 0 ? [["Provider observed", formatTokens(node.data.observedTokens)] as const] : []),
        ...(summarizedTouched.length > 0 ? [["Touched nodes", String(summarizedTouched.length)] as const] : []),
        ...(summarizedChanged.length > 0 ? [["Changed nodes", String(summarizedChanged.length)] as const] : []),
        ...(summarizedDelivered.length > 0 ? [["Delivered nodes", String(summarizedDelivered.length)] as const] : []),
        ...(summarizedVerified.length > 0 ? [["Verified nodes", String(summarizedVerified.length)] as const] : []),
        ...(summarizedEvents.length > 0 ? [["Evidence events", String(summarizedEvents.length)] as const] : []),
        ...(summarizedNodeLabels.length > 0 ? [["Mapped code", summarizedNodeLabels.join(" · ")] as const] : []),
        ...(missingSkills.length > 0 ? [["Missing skills", missingSkills.join(" · ")] as const] : []),
        ...(missingHooks.length > 0 ? [["Missing hooks", missingHooks.join(" · ")] as const] : []),
        ...(parameters.length > 0 ? [["Parameters", parameters.join(", ")] as const] : []),
        ...(source && typeof source.data.returns === "string" ? [["Returns", source.data.returns] as const] : []),
        ...(fields.length > 0 ? [["Fields", fields.slice(0, 8).join(" · ")] as const] : []),
        ...(typeof executionCount === "number" ? [["Executed", `${executionCount} call${executionCount === 1 ? "" : "s"}`] as const] : []),
        ...(calledFunctions.length > 0 ? [["Calls", calledFunctions.join(" · ")] as const] : []),
        ...(callers.length > 0 ? [["Called by", callers.join(" · ")] as const] : []),
        ...(models.length > 0 ? [["Data models", models.join(" · ")] as const] : []),
        ...(typeof node.event?.data.laneId === "string" ? [["Workflow lane", node.event.data.laneId] as const] : []),
        ...(typeof node.event?.data.agentType === "string" ? [["Agent type", node.event.data.agentType] as const] : []),
        ...(typeof node.event?.data.model === "string" ? [["Model", node.event.data.model] as const] : []),
        ...(typeof node.event?.data.totalTokens === "number" ? [["Agent tokens", formatTokens(node.event.data.totalTokens)] as const] : []),
        ...(node.event ? [["Event", node.event.type] as const] : [])
      ],
      diff: typeof node.event?.data.diff === "string" ? node.event.data.diff : typeof changed?.data.diff === "string" ? changed.data.diff : (deliveryRole?.includes("deliver") || summarizedDelivered.length > 0) && delivery?.diff ? delivery.diff : undefined
    });
  }, [cycle, delivery, graph, visibleEvents]);

  const inspectLifecycle = useCallback((kind: LifecycleKind, id: string): void => {
    if (!cycle) return;
    const evidence = lifecycleEvidence(cycle, kind, id);
    const prompt = kind === "prompt" ? cycle.prompts.find((item) => item.id === id) : undefined;
    const workflow = kind === "workflow" ? cycle.workflows.find((item) => item.id === id) : undefined;
    const agent = kind === "agent" ? cycle.agents.find((item) => item.id === id) : undefined;
    const lifecycleStatus = kind === "cycle" ? cycle.status : prompt?.status ?? workflow?.status ?? agent?.status ?? "planned";
    const status: DisplayNode["status"] = lifecycleStatus === "completed" || lifecycleStatus === "stopped" ? "passed"
      : lifecycleStatus === "blocked" || lifecycleStatus === "failed" || lifecycleStatus === "missed" ? "failed"
        : lifecycleStatus === "active" ? "active" : "planned";
    const label = kind === "cycle" ? `Cycle ${cycle.ordinal}: ${cycle.prompt}` : prompt?.text ?? workflow?.name ?? agent?.description ?? agent?.agentType ?? "Agent";
    const detail = kind === "cycle" ? `${cycle.status} prompt cycle from ${formatTime(cycle.startedAt)}${cycle.stoppedAt ? ` to ${formatTime(cycle.stoppedAt)}` : ""}`
      : kind === "prompt" ? `${prompt?.kind ?? "nested"} prompt · ${prompt?.status ?? "planned"}`
        : kind === "workflow" ? `${workflow?.status ?? "planned"} workflow · ${workflow?.invokedSkills.length ?? 0}/${workflow?.expectedSkills.length ?? 0} required skills observed`
          : `${agent?.parentAgentRunId ? "nested" : "main"} agent · ${agent?.status ?? "planned"} · ${agent?.model ?? "model unreported"}`;
    inspectNode({
      id: lifecycleNodeId(kind, id), label, kicker: kind, subtitle: detail, status,
      data: {
        lifecycleKind: kind, lifecycleId: id, touchedNodeIds: evidence.touchedNodeIds, changedNodeIds: evidence.changedNodeIds,
        deliveredNodeIds: evidence.deliveredNodeIds, verifiedNodeIds: evidence.verifiedNodeIds, eventIds: evidence.eventIds, tokens: evidence.tokens,
        ...(agent ? { observedTokens: agent.tokenUsage, model: agent.model, agentType: agent.agentType } : {}),
        ...(workflow ? { missingSkills: workflow.expectedSkills.filter((skill) => !workflow.invokedSkills.includes(skill)), missingHooks: workflow.expectedHooks.filter((hook) => !workflow.observedHooks.includes(hook)) } : {})
      }
    });
    setMode("scenario");
  }, [cycle, inspectNode]);

  const selectLifecycleFromTree = useCallback((runId: string, kind: LifecycleKind, id: string): void => {
    if (runId === selectedRunId) {
      inspectLifecycle(kind, id);
      return;
    }
    setPendingLifecycleSelection({ runId, kind, id });
    setSelectedRunId(runId);
  }, [inspectLifecycle, selectedRunId]);

  useEffect(() => {
    if (!pendingLifecycleSelection || !cycle || cycle.runId !== pendingLifecycleSelection.runId) return;
    inspectLifecycle(pendingLifecycleSelection.kind, pendingLifecycleSelection.id);
    setPendingLifecycleSelection(null);
  }, [cycle, inspectLifecycle, pendingLifecycleSelection]);

  const clearNodeFocus = useCallback((): void => {
    setSelectedNodeId(null);
    setInspector(DEFAULT_INSPECTOR);
  }, []);

  const openNode = useCallback((node: DisplayNode): void => {
    inspectNode(node);
    if (node.kind === "project") setSelectedProjectId(node.id);
    if (node.kind === "route") setMode("routes");
  }, [inspectNode]);

  const inspectEvent = useCallback((event: LedgerEvent): void => {
    setSelectedNodeId(null);
    if (window.innerWidth <= 780) setShowDetails(true);
    setInspector({ title: EVENT_LABELS[event.type] ?? event.type, detail: eventDetail(event), values: [
      ["Sequence", String(event.seq)], ["Status", event.status], ["Time", formatTime(event.timestamp)], ["Mapped nodes", String(event.nodeIds.length)],
      ...(typeof event.data.laneId === "string" ? [["Workflow lane", event.data.laneId] as const] : []),
      ...(typeof event.data.stage === "string" ? [["Stage", event.data.stage] as const] : []), ...(typeof event.data.exitCode === "number" ? [["Exit code", String(event.data.exitCode)] as const] : [])
    ], diff: typeof event.data.diff === "string" ? event.data.diff : undefined });
  }, []);

  const selectProject = (projectId: string | null): void => {
    setSelectedProjectId(projectId);
    setSelectedNodeId(null);
    setInspector(DEFAULT_INSPECTOR);
  };

  const selectRoute = (route: RouteDefinition): void => {
    setSelectedProjectId(route.projectId);
    const node = graph.nodes.find((candidate) => candidate.id === route.id);
    if (node) inspectNode({ ...node, kicker: node.kind, status: "planned", subtitle: route.evidence });
  };

  const enableAlerts = async (): Promise<void> => {
    if (!("Notification" in window)) { setNotificationPermission("unsupported"); return; }
    if (Notification.permission === "granted") {
      setNotificationPermission("granted");
      if (run && usage) deliverTokenAlert(run, usage, true);
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === "granted" && run && usage) deliverTokenAlert(run, usage, usage.warning ? false : true);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-mark" aria-hidden="true">P/R</span><div><strong>Proof &amp; Replay</strong><span>Architecture and evidence for AI-written code</span></div></div>
        <div className="topbar__actions">
          <a className="author" href="mailto:raykundan57@gmail.com"><span>Kundan Ray</span><small>raykundan57@gmail.com</small></a>
          <Badge tone="live" dot>Live</Badge>
          <Select label="Select proof run" compact value={selectedRunId} onChange={(event) => setSelectedRunId(event.currentTarget.value)} disabled={runs.length === 0}>
            {runs.length === 0 ? <option value="">No runs recorded</option> : null}
            {runs.map((item) => <option key={item.id} value={item.id}>{item.status === "completed" ? "✓" : item.status === "blocked" ? "×" : "•"} {truncate(item.prompt, 36)}</option>)}
          </Select>
        </div>
      </header>

      <main className="page">
        <aside className="session-sidebar" aria-label="Sessions and nested prompt cycles">
          <div className="session-sidebar__title"><div><p className="eyebrow">Execution history</p><h2>Sessions</h2></div><span>{sessions.length}</span></div>
          <div className="session-tree">
            {sessions.length === 0 ? <p className="session-tree__empty">Waiting for an attached agent session.</p> : sessions.map((record, index) => {
              const sessionOpen = expandedSessionIds.has(record.id);
              const sessionActive = record.id === session?.id;
              return <section className={`session-tree__session ${sessionActive ? "is-active" : ""}`} key={record.id}>
                <div className="session-tree__header">
                  <button type="button" className="session-tree__toggle" aria-label={`${sessionOpen ? "Collapse" : "Expand"} session ${sessions.length - index}`} aria-expanded={sessionOpen} onClick={() => toggleSession(record.id)}>{sessionOpen ? "−" : "+"}</button>
                  <button type="button" className="session-tree__select" onClick={() => { const latest = record.cycles.at(-1); if (latest) setSelectedRunId(latest.runId); setExpandedSessionIds((current) => new Set([...current, record.id])); }}><strong>Session {sessions.length - index}</strong><small>{record.provider} · {record.cycles.length} cycle{record.cycles.length === 1 ? "" : "s"}</small></button>
                </div>
                {sessionOpen ? <div className="session-tree__cycles">{record.cycles.map((itemCycle) => {
                  const cycleOpen = expandedCycleIds.has(itemCycle.id);
                  const cycleActive = itemCycle.runId === selectedRunId;
                  const cycleEvidence = lifecycleEvidence(itemCycle, "cycle", itemCycle.id);
                  return <div className={`session-tree__cycle ${cycleActive ? "is-active" : ""}`} key={itemCycle.id}>
                    <div className="session-tree__cycle-header">
                      <button type="button" className="session-tree__toggle" aria-label={`${cycleOpen ? "Collapse" : "Expand"} cycle ${itemCycle.ordinal}`} aria-expanded={cycleOpen} onClick={() => toggleCycle(itemCycle.id)}>{cycleOpen ? "−" : "+"}</button>
                      <button type="button" className="session-tree__cycle-select" onClick={() => { setSelectedRunId(itemCycle.runId); setExpandedCycleIds((current) => new Set([...current, itemCycle.id])); }}><span>Cycle {itemCycle.ordinal}</span><strong>{truncate(itemCycle.prompt, 34)}</strong><small>{itemCycle.status} · {formatTokens(cycleEvidence.tokens)} · {cycleEvidence.touchedNodeIds.length} nodes</small></button>
                    </div>
                    {cycleOpen ? <div className="session-tree__nested">
                      <p>Prompts</p>
                      {itemCycle.prompts.map((prompt, promptIndex) => { const evidence = lifecycleEvidence(itemCycle, "prompt", prompt.id); const nodeId = lifecycleNodeId("prompt", prompt.id); return <button type="button" className={cycleActive && selectedNodeId === nodeId ? "is-active" : ""} aria-pressed={cycleActive && selectedNodeId === nodeId} key={prompt.id} onClick={() => selectLifecycleFromTree(itemCycle.runId, "prompt", prompt.id)}><i>{promptIndex + 1}</i><span><strong>{truncate(prompt.text, 32)}</strong><small>{prompt.kind} · {prompt.status} · {formatTokens(evidence.tokens)}</small></span></button>; })}
                      {itemCycle.workflows.length > 0 ? <p>Workflows</p> : null}
                      {itemCycle.workflows.map((workflow) => { const evidence = lifecycleEvidence(itemCycle, "workflow", workflow.id); const nodeId = lifecycleNodeId("workflow", workflow.id); return <button type="button" className={cycleActive && selectedNodeId === nodeId ? "is-active" : ""} aria-pressed={cycleActive && selectedNodeId === nodeId} key={workflow.id} onClick={() => selectLifecycleFromTree(itemCycle.runId, "workflow", workflow.id)}><i>W</i><span><strong>{truncate(workflow.name, 32)}</strong><small>{workflow.status} · {formatTokens(evidence.tokens)} · {evidence.touchedNodeIds.length} nodes</small></span></button>; })}
                      {itemCycle.agents.length > 0 ? <p>Agents</p> : null}
                      {itemCycle.agents.map((agent) => { const evidence = lifecycleEvidence(itemCycle, "agent", agent.id); const nodeId = lifecycleNodeId("agent", agent.id); return <button type="button" className={`${agent.parentAgentRunId ? "is-nested" : ""} ${cycleActive && selectedNodeId === nodeId ? "is-active" : ""}`} aria-pressed={cycleActive && selectedNodeId === nodeId} key={agent.id} onClick={() => selectLifecycleFromTree(itemCycle.runId, "agent", agent.id)}><i>{agent.parentAgentRunId ? "↳" : "A"}</i><span><strong>{truncate(agent.description ?? agent.agentType ?? "Agent", 32)}</strong><small>{agent.status} · {formatTokens(evidence.tokens)} · {evidence.touchedNodeIds.length} nodes</small></span></button>; })}
                    </div> : null}
                  </div>;
                })}</div> : null}
              </section>;
            })}
          </div>
        </aside>

        <section className="main-stage">
        <nav className="view-tabs" aria-label="View modes">
          {([ ["model", "Mental model"], ["scenario", "Live scenario"], ["routes", `Routes ${routes.length}`], ["proof", "Evidence"] ] as const).map(([value, label]) => <button key={value} type="button" className={mode === value ? "is-active" : ""} onClick={() => setMode(value)}>{label}</button>)}
        </nav>
        {error ? <div className="error-banner" role="alert">Dashboard error: {error}</div> : null}
        <section className="task-summary" aria-labelledby="task-heading">
          <div><p className="eyebrow">{session ? `${session.provider} session · cycle ${cycle?.ordinal ?? 1}` : "Live agent session"}</p><h1 id="task-heading">{run?.prompt ?? "Waiting for a recorded task"}</h1><p className="task-summary__meta">{run ? `${run.id} · started ${formatTime(run.createdAt)} · ${displayedRun?.status ?? run.status}` : "Attach an agent session to activate the project model."}</p></div>
          <div className="proof-score" aria-label={`${passedChecks} of ${checks.length} proof checks passed`}><span>{passedChecks}/{checks.length}</span><small>proof checks</small></div>
        </section>

        <section className={`usage-strip ${usage?.warning ? "usage-strip--warning" : ""}`} aria-label="Agent token usage">
          <div className="usage-strip__summary"><p className="eyebrow">Session tokens</p><strong>{usage ? formatTokens(usage.totalTokens) : "—"}</strong><span>{usage ? `${Math.round(usagePercent)}% of ${formatTokens(warningThreshold)} warning level` : "Waiting for Claude usage evidence"}</span></div>
          <div className="usage-meter" aria-hidden="true"><span style={{ width: `${usagePercent}%` }} /></div>
          <dl className="usage-breakdown">
            <div><dt>Input</dt><dd>{formatTokens(usage?.inputTokens ?? 0)}</dd></div>
            <div><dt>Output</dt><dd>{formatTokens(usage?.outputTokens ?? 0)}</dd></div>
            <div><dt>Cache write</dt><dd>{formatTokens(usage?.cacheCreationInputTokens ?? 0)}</dd></div>
            <div><dt>Cache read</dt><dd>{formatTokens(usage?.cacheReadInputTokens ?? 0)}</dd></div>
          </dl>
          <Button size="small" variant={notificationPermission === "granted" ? "ghost" : "secondary"} onClick={() => void enableAlerts()} disabled={notificationPermission === "denied" || notificationPermission === "unsupported"}>
            {notificationPermission === "granted" ? "Test alert" : notificationPermission === "denied" ? "Alerts blocked" : notificationPermission === "unsupported" ? "Alerts unavailable" : "Enable token alerts"}
          </Button>
        </section>
        {tokenAlarm ? <div className="token-alarm" role="alert"><span aria-hidden="true">!</span><div><strong>{tokenAlarm.title}</strong><p>{tokenAlarm.detail}</p></div><button type="button" aria-label="Dismiss token alert" onClick={() => setTokenAlarm(null)}>×</button></div> : null}

        {cycle ? <section className={`delivery-ledger ${delivery ? "delivery-ledger--final" : ""}`} aria-label="Touched and delivered node comparison">
          <div><p className="eyebrow">Cycle evidence</p><strong>{delivery ? "Delivery calculated" : "Exploration active"}</strong><small>{cycle.prompts.length} prompts · {cycle.workflows.length} workflows · {cycle.agents.length} agents</small></div>
          <dl>
            <div><dt>Touched</dt><dd>{delivery?.touchedNodeIds.length ?? new Set(cycle.interactions.map((item) => item.nodeId)).size}</dd></div>
            <div><dt>Changed</dt><dd>{delivery?.changedNodeIds.length ?? new Set(cycle.interactions.filter((item) => item.role === "changed").map((item) => item.nodeId)).size}</dd></div>
            <div><dt>Delivered</dt><dd>{delivery?.deliveredNodeIds.length ?? "—"}</dd></div>
            <div><dt>References</dt><dd>{delivery?.referenceNodeIds.length ?? "—"}</dd></div>
            <div><dt>Reverted</dt><dd>{delivery?.revertedNodeIds.length ?? "—"}</dd></div>
            <div><dt>Unrelated</dt><dd>{delivery?.unrelatedTouchedNodeIds.length ?? "—"}</dd></div>
          </dl>
          <div className="delivery-ledger__contract"><span className={delivery?.compliance.missingSkills.length || delivery?.compliance.missingHooks.length ? "is-missed" : ""}>{delivery ? `${delivery.compliance.missingSkills.length + delivery.compliance.missingHooks.length} missed workflow requirements` : `${cycle.skills.length} skills · ${cycle.hooks.length} hooks observed`}</span><small>{delivery ? `${formatTokens(delivery.allocatedTokens)} attributed · ${formatTokens(delivery.unallocatedTokens)} unallocated tokens` : "Final roles are assigned when the prompt cycle stops"}</small></div>
        </section> : null}

        <div className="scope-tabs" aria-label="Project scope">
          <button type="button" className={!selectedProjectId ? "is-active" : ""} onClick={() => selectProject(null)}>Whole repository</button>
          {projects.filter((project) => project.path !== ".").map((project) => <button key={project.id} type="button" className={selectedProjectId === project.id ? "is-active" : ""} onClick={() => selectProject(project.id)}>{project.name}<span>{project.stats.routes}</span></button>)}
        </div>

        <div className={`workspace workspace--${mode} ${showNavigator ? "" : "workspace--navigator-hidden"} ${showDetails ? "" : "workspace--detail-hidden"}`}>
          <Panel className={`navigator-panel overlay-panel ${showNavigator ? "" : "is-hidden"}`} aria-labelledby="navigator-heading">
            {mode === "proof" ? (
              <><PanelHeader eyebrow="Append-only ledger" title="Execution" titleId="navigator-heading" action={<span className="event-count">{visibleEvents.length}</span>} /><ol className="timeline">{[...visibleEvents].reverse().map((event) => <li key={event.id} className={`timeline__item timeline__item--${event.status}`}><button type="button" onClick={() => inspectEvent(event)}><strong>{EVENT_LABELS[event.type] ?? event.type}</strong><span>{formatTime(event.timestamp)} · {truncate(eventDetail(event), 34)}</span></button></li>)}</ol></>
            ) : mode === "routes" ? (
              <><PanelHeader eyebrow="Discovered interface" title={`${filteredRoutes.length} routes`} titleId="navigator-heading" /><div className="route-search"><input value={routeQuery} onChange={(event) => setRouteQuery(event.currentTarget.value)} placeholder="Filter method, path, or file" aria-label="Filter routes" /></div><ol className="route-list">{filteredRoutes.map((route) => <li key={route.id}><button type="button" className={selectedNodeId === route.id ? "is-active" : ""} onClick={() => selectRoute(route)}><span className={`method method--${route.kind}`}>{route.method}</span><strong>{route.path}</strong><small>{route.file}:{route.line}</small></button></li>)}</ol></>
            ) : mode === "scenario" ? (
              <><PanelHeader eyebrow="Session structure" title={`Cycle ${cycle?.ordinal ?? 1}`} titleId="navigator-heading" action={<span className="event-count">{cycle?.prompts.length ?? 0}</span>} />
                <div className="session-hierarchy">
                  {cycle ? (() => { const evidence = lifecycleEvidence(cycle, "cycle", cycle.id); const nodeId = lifecycleNodeId("cycle", cycle.id); return <button type="button" className={`session-hierarchy__overview ${selectedNodeId === nodeId ? "is-active" : ""}`} aria-pressed={selectedNodeId === nodeId} onClick={() => inspectLifecycle("cycle", cycle.id)}><span>Cycle {cycle.ordinal}</span><strong>{formatTokens(evidence.tokens)} mapped tokens</strong><small>{evidence.touchedNodeIds.length} touched · {evidence.changedNodeIds.length} changed · {evidence.deliveredNodeIds.length} delivered</small></button>; })() : null}
                  <p className="eyebrow">Prompt lifecycles</p>
                  {(cycle?.prompts ?? []).map((prompt, index) => { const evidence = lifecycleEvidence(cycle!, "prompt", prompt.id); const nodeId = lifecycleNodeId("prompt", prompt.id); return <button type="button" key={prompt.id} className={`session-hierarchy__row session-hierarchy__row--${prompt.kind} ${selectedNodeId === nodeId ? "is-active" : ""}`} aria-pressed={selectedNodeId === nodeId} onClick={() => inspectLifecycle("prompt", prompt.id)}><span>{index + 1}</span><div><strong>{truncate(prompt.text, 42)}</strong><small>{prompt.kind} · {prompt.status} · {formatTokens(evidence.tokens)} tokens</small><small>{evidence.touchedNodeIds.length} touched · {evidence.deliveredNodeIds.length} delivered</small></div></button>; })}
                  <p className="eyebrow">Workflows and agents</p>
                  {(cycle?.workflows ?? []).map((workflow) => { const evidence = lifecycleEvidence(cycle!, "workflow", workflow.id); const nodeId = lifecycleNodeId("workflow", workflow.id); return <button type="button" className={`session-hierarchy__group ${selectedNodeId === nodeId ? "is-active" : ""}`} aria-pressed={selectedNodeId === nodeId} onClick={() => inspectLifecycle("workflow", workflow.id)} key={workflow.id}><strong>{workflow.name}</strong><small>{workflow.status} · {formatTokens(evidence.tokens)} tokens · {evidence.touchedNodeIds.length} nodes</small><small>{workflow.invokedSkills.length}/{workflow.expectedSkills.length} skills · {workflow.observedHooks.length}/{workflow.expectedHooks.length} hooks</small></button>; })}
                  {(cycle?.agents ?? []).map((agent) => { const evidence = lifecycleEvidence(cycle!, "agent", agent.id); const nodeId = lifecycleNodeId("agent", agent.id); return <button type="button" className={`session-hierarchy__group ${agent.parentAgentRunId ? "is-nested" : ""} ${selectedNodeId === nodeId ? "is-active" : ""}`} aria-pressed={selectedNodeId === nodeId} onClick={() => inspectLifecycle("agent", agent.id)} key={agent.id}><strong>{agent.description ?? agent.agentType ?? "Agent"}</strong><small>{agent.status} · {agent.model ?? "model unreported"} · {formatTokens(evidence.tokens)} mapped</small><small>{evidence.touchedNodeIds.length} touched · {evidence.changedNodeIds.length} changed · {evidence.deliveredNodeIds.length} delivered{agent.tokenUsage > 0 ? ` · ${formatTokens(agent.tokenUsage)} observed` : ""}</small></button>; })}
                </div>
                <div className="scenario-summary"><p className="eyebrow">Mapped or inferred</p><strong>{visibleEvents.filter((event) => eventHasRepositoryContext(event, graph)).length}/{visibleEvents.length}</strong><span>events linked directly to repository nodes or inferred from repository paths in older shell activity.</span></div></>
            ) : (
              <><PanelHeader eyebrow="Repository map" title="Projects" titleId="navigator-heading" action={<span className="event-count">{projects.length}</span>} /><ol className="project-list">{projects.map((project) => <li key={project.id}><button type="button" className={selectedProjectId === project.id ? "is-active" : ""} onClick={() => selectProject(project.path === "." ? null : project.id)}><strong>{project.name}</strong><span>{project.kind} · {project.frameworks.join(" + ") || "TypeScript / JavaScript"}</span><small>{project.stats.files} files · {project.stats.functions} functions · {project.stats.routes} routes · {project.stats.dataModels ?? 0} models</small></button></li>)}</ol></>
            )}
          </Panel>

          <Panel className="graph-panel" aria-labelledby="graph-heading">
            <div className="graph-toolbar">
              <div><p className="eyebrow">{mode === "model" ? "System architecture" : mode === "scenario" ? "Activated path" : mode === "routes" ? "Interface map" : "Completion contract"}</p><h2 id="graph-heading">{mode === "model" ? (selectedProjectId ? "Project mental model" : "Whole-project mental model") : mode === "scenario" ? "Live project scenario" : mode === "routes" ? "Routes and handlers" : "Proof graph"}</h2></div>
              <div className="canvas-panels" aria-label="Canvas panels">{mode !== "scenario" ? <button type="button" className={showNavigator ? "is-active" : ""} onClick={() => setShowNavigator((value) => !value)}>Navigator</button> : null}<button type="button" className={showDetails ? "is-active" : ""} onClick={() => setShowDetails((value) => !value)}>Details</button>{delivery ? <><button type="button" className={traceView === "exploration" ? "is-active" : ""} onClick={() => setTraceView("exploration")}>Touched</button><button type="button" className={traceView === "delivery" ? "is-active" : ""} onClick={() => setTraceView("delivery")}>Delivered</button></> : null}</div>
              {selectedProjectId ? <Button variant="ghost" size="small" onClick={() => selectProject(null)}>← Whole repository</Button> : null}
              <Button variant="secondary" size="small" busy={replaying} leadingIcon={<PlayIcon />} onClick={() => { setMode("scenario"); setReplayCount(0); }} disabled={events.length === 0}>{replaying ? "Replaying" : "Replay run"}</Button>
            </div>
            <GraphCanvas mode={mode} graph={graph} events={visibleEvents} selectedNodeId={selectedNodeId} selectedProjectId={selectedProjectId} onSelectNode={inspectNode} onOpenNode={openNode} onClearSelection={clearNodeFocus} delivery={delivery} traceView={traceView} cycle={cycle} />
            <div className="legend" aria-label="Graph status legend">{(["planned", "active", "passed", "changed", "failed"] as const).map((status) => <span key={status}><i className={`legend__dot legend__dot--${status}`} />{status === "passed" ? "Verified" : status}</span>)}<span className="legend__hint">Double-click a project or route to expand it</span></div>
          </Panel>

          <Panel className={`detail-panel overlay-panel ${showDetails ? "" : "is-hidden"}`} aria-labelledby="detail-heading">
            <PanelHeader eyebrow="Selected context" title={inspector.title} titleId="detail-heading" action={mode === "proof" ? <Badge tone={proofTone(displayedRun)}>{proofLabel(displayedRun)}</Badge> : null} />
            {mode === "proof" ? <ul className="proof-checks">{checks.map((check) => <li key={check.id} className={check.passed ? "is-passed" : displayedRun?.status === "blocked" ? "is-failed" : ""}><span className="proof-checks__icon" aria-hidden="true">{check.passed ? "✓" : displayedRun?.status === "blocked" ? "×" : "○"}</span><span>{check.label}</span></li>)}</ul> : null}
            <div className="inspector inspector--flush"><p>{inspector.detail}</p><dl>{inspector.values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></div>
            {inspector.diff ? <div className="diff-view"><p className="eyebrow">Recorded diff</p><pre>{inspector.diff}</pre></div> : null}
            <div className="model-note"><p className="eyebrow">Inference policy</p><p>Explicit syntax is high confidence. Unique symbol matches are medium confidence. Every inferred edge carries its reason so a reviewer can challenge it.</p></div>
          </Panel>
        </div>
        </section>
      </main>
      <footer className="footer"><span>Proof &amp; Replay</span><span>Created by Kundan Ray · <a href="mailto:raykundan57@gmail.com">raykundan57@gmail.com</a></span></footer>
    </div>
  );
}
