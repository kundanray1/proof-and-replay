import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LedgerEvent, ProofCheck, ProofReplayConfig, ProofResult, ProofRun, RepositoryGraph, RouteDefinition, TokenUsage } from "../types.js";
import { GraphCanvas } from "./components/GraphCanvas.js";
import type { DisplayNode, GraphMode } from "./components/GraphCanvas.js";
import { Badge, Button, Panel, PanelHeader, PlayIcon, Select } from "./components/primitives.js";

const EMPTY_GRAPH: RepositoryGraph = { schemaVersion: 1, generatedAt: "", root: "", nodes: [], edges: [], stats: { files: 0, functions: 0, tests: 0, edges: 0, projects: 0, routes: 0 } };
const EMPTY_CONFIG: ProofReplayConfig = {
  schemaVersion: 1,
  sourceExtensions: [],
  exclude: [],
  proofPolicy: { requireReproduction: true, requireChange: true, requirePassingVerification: true, requireExecutedChangedNode: true },
  tokenMonitoring: { sessionWarningTokens: 200_000, turnSpikeTokens: 50_000 }
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
  "workflow.task.updated": "Workflow task updated", "workflow.task.stopped": "Workflow task stopped"
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
  const [selectedRunId, setSelectedRunId] = useState("");
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [proof, setProof] = useState<ProofResult | null>(null);
  const [mode, setMode] = useState<GraphMode>("model");
  const [replayCount, setReplayCount] = useState<number | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [routeQuery, setRouteQuery] = useState("");
  const [inspector, setInspector] = useState<InspectorState>(DEFAULT_INSPECTOR);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(permissionState);
  const [tokenAlarm, setTokenAlarm] = useState<TokenAlarm | null>(null);
  const [showNavigator, setShowNavigator] = useState(() => window.innerWidth > 780);
  const [showDetails, setShowDetails] = useState(() => window.innerWidth > 780);
  const [error, setError] = useState<string | null>(null);
  const notifiedKey = useRef<string | null>(null);

  const run = useMemo(() => runs.find((candidate) => candidate.id === selectedRunId) ?? null, [runs, selectedRunId]);
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
    let cancelled = false;
    Promise.all([fetchJson<RepositoryGraph>("/api/graph"), fetchJson<ProofRun[]>("/api/runs"), fetchJson<ProofReplayConfig>("/api/config")]).then(([nextGraph, nextRuns, nextConfig]) => {
      if (cancelled) return;
      setGraph(nextGraph);
      setRuns(nextRuns);
      setConfig(nextConfig);
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
      const requests: [Promise<ProofRun[]>, Promise<ProofResult>, Promise<RepositoryGraph> | null] = [
        fetchJson<ProofRun[]>("/api/runs"),
        fetchJson<ProofResult>(`/api/proof?runId=${encodeURIComponent(selectedRunId)}`),
        event.type === "file.changed" ? fetchJson<RepositoryGraph>("/api/graph") : null
      ];
      void Promise.all([requests[0], requests[1], requests[2] ?? Promise.resolve(null)]).then(([nextRuns, nextProof, nextGraph]) => {
        if (cancelled) return;
        setRuns(nextRuns);
        setProof(nextProof);
        if (nextGraph) setGraph(nextGraph);
      });
    };
    stream.addEventListener("proof-event", onProofEvent as EventListener);
    return () => { cancelled = true; stream.removeEventListener("proof-event", onProofEvent as EventListener); stream.close(); };
  }, [selectedRunId]);

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
    setInspector({
      title: node.label,
      detail: inference ?? (node.subtitle || (node.file ? `${node.file}${node.line ? `:${node.line}` : ""}` : `${node.kicker} evidence node`)),
      values: [
        ["Type", node.kind ?? node.kicker], ["Status", node.status],
        ...(node.file ? [["File", node.file] as const] : []), ...(node.line ? [["Line", String(node.line)] as const] : []),
        ...(confidence ? [["Confidence", confidence] as const] : []), ...(source ? [["Incoming", String(incoming.length)] as const, ["Outgoing", String(outgoing.length)] as const] : []),
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
      diff: typeof node.event?.data.diff === "string" ? node.event.data.diff : typeof changed?.data.diff === "string" ? changed.data.diff : undefined
    });
  }, [graph, visibleEvents]);

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
    setSelectedNodeId(projectId);
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
        {error ? <div className="error-banner" role="alert">Dashboard error: {error}</div> : null}
        <section className="task-summary" aria-labelledby="task-heading">
          <div><p className="eyebrow">Live agent session</p><h1 id="task-heading">{run?.prompt ?? "Waiting for a recorded task"}</h1><p className="task-summary__meta">{run ? `${run.id} · started ${formatTime(run.createdAt)} · ${displayedRun?.status ?? run.status}` : "Attach an agent session to activate the project model."}</p></div>
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

        <nav className="view-tabs" aria-label="Repository views">
          {([ ["model", "Mental model"], ["scenario", "Live scenario"], ["routes", `Routes ${routes.length}`], ["proof", "Evidence"] ] as const).map(([value, label]) => <button key={value} type="button" className={mode === value ? "is-active" : ""} onClick={() => setMode(value)}>{label}</button>)}
        </nav>

        <div className="scope-tabs" aria-label="Project scope">
          <button type="button" className={!selectedProjectId ? "is-active" : ""} onClick={() => selectProject(null)}>Whole repository</button>
          {projects.filter((project) => project.path !== ".").map((project) => <button key={project.id} type="button" className={selectedProjectId === project.id ? "is-active" : ""} onClick={() => selectProject(project.id)}>{project.name}<span>{project.stats.routes}</span></button>)}
        </div>

        <div className={`workspace workspace--model ${showNavigator ? "" : "workspace--navigator-hidden"} ${showDetails ? "" : "workspace--detail-hidden"}`}>
          <Panel className={`navigator-panel overlay-panel ${showNavigator ? "" : "is-hidden"}`} aria-labelledby="navigator-heading">
            {mode === "proof" ? (
              <><PanelHeader eyebrow="Append-only ledger" title="Execution" titleId="navigator-heading" action={<span className="event-count">{visibleEvents.length}</span>} /><ol className="timeline">{[...visibleEvents].reverse().map((event) => <li key={event.id} className={`timeline__item timeline__item--${event.status}`}><button type="button" onClick={() => inspectEvent(event)}><strong>{EVENT_LABELS[event.type] ?? event.type}</strong><span>{formatTime(event.timestamp)} · {truncate(eventDetail(event), 34)}</span></button></li>)}</ol></>
            ) : mode === "routes" ? (
              <><PanelHeader eyebrow="Discovered interface" title={`${filteredRoutes.length} routes`} titleId="navigator-heading" /><div className="route-search"><input value={routeQuery} onChange={(event) => setRouteQuery(event.currentTarget.value)} placeholder="Filter method, path, or file" aria-label="Filter routes" /></div><ol className="route-list">{filteredRoutes.map((route) => <li key={route.id}><button type="button" className={selectedNodeId === route.id ? "is-active" : ""} onClick={() => selectRoute(route)}><span className={`method method--${route.kind}`}>{route.method}</span><strong>{route.path}</strong><small>{route.file}:{route.line}</small></button></li>)}</ol></>
            ) : (
              <><PanelHeader eyebrow="Repository map" title="Projects" titleId="navigator-heading" action={<span className="event-count">{projects.length}</span>} /><ol className="project-list">{projects.map((project) => <li key={project.id}><button type="button" className={selectedProjectId === project.id ? "is-active" : ""} onClick={() => selectProject(project.path === "." ? null : project.id)}><strong>{project.name}</strong><span>{project.kind} · {project.frameworks.join(" + ") || "TypeScript / JavaScript"}</span><small>{project.stats.files} files · {project.stats.functions} functions · {project.stats.routes} routes · {project.stats.dataModels ?? 0} models</small></button></li>)}</ol>{mode === "scenario" ? <div className="scenario-summary"><p className="eyebrow">Mapped or inferred</p><strong>{visibleEvents.filter((event) => eventHasRepositoryContext(event, graph)).length}/{visibleEvents.length}</strong><span>events linked directly to repository nodes or inferred from repository paths in older shell activity.</span></div> : null}</>
            )}
          </Panel>

          <Panel className="graph-panel" aria-labelledby="graph-heading">
            <div className="graph-toolbar">
              <div><p className="eyebrow">{mode === "model" ? "System architecture" : mode === "scenario" ? "Activated path" : mode === "routes" ? "Interface map" : "Completion contract"}</p><h2 id="graph-heading">{mode === "model" ? (selectedProjectId ? "Project mental model" : "Whole-project mental model") : mode === "scenario" ? "Live project scenario" : mode === "routes" ? "Routes and handlers" : "Proof graph"}</h2></div>
              <div className="canvas-panels" aria-label="Canvas panels"><button type="button" className={showNavigator ? "is-active" : ""} onClick={() => setShowNavigator((value) => !value)}>Projects</button><button type="button" className={showDetails ? "is-active" : ""} onClick={() => setShowDetails((value) => !value)}>Details</button></div>
              {selectedProjectId ? <Button variant="ghost" size="small" onClick={() => selectProject(null)}>← Whole repository</Button> : null}
              <Button variant="secondary" size="small" busy={replaying} leadingIcon={<PlayIcon />} onClick={() => { setMode("scenario"); setReplayCount(0); }} disabled={events.length === 0}>{replaying ? "Replaying" : "Replay run"}</Button>
            </div>
            <GraphCanvas mode={mode} graph={graph} events={visibleEvents} selectedNodeId={selectedNodeId} selectedProjectId={selectedProjectId} onSelectNode={inspectNode} onOpenNode={openNode} />
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
      </main>
      <footer className="footer"><span>Proof &amp; Replay</span><span>Created by Kundan Ray · <a href="mailto:raykundan57@gmail.com">raykundan57@gmail.com</a></span></footer>
    </div>
  );
}
