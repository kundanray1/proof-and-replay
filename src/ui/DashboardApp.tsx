import { useCallback, useEffect, useMemo, useState } from "react";
import type { LedgerEvent, ProofCheck, ProofResult, ProofRun, RepositoryGraph } from "../types.js";
import { GraphCanvas } from "./components/GraphCanvas.js";
import type { DisplayNode, GraphMode } from "./components/GraphCanvas.js";
import {
  Badge,
  Button,
  Panel,
  PanelHeader,
  PlayIcon,
  SegmentedControl,
  Select
} from "./components/primitives.js";

const EMPTY_GRAPH: RepositoryGraph = {
  schemaVersion: 1,
  generatedAt: "",
  root: "",
  nodes: [],
  edges: [],
  stats: { files: 0, functions: 0, tests: 0, edges: 0 }
};

const EMPTY_CHECKS: Array<Pick<ProofCheck, "id" | "label" | "passed">> = [
  { id: "reproduction", label: "Original failure reproduced", passed: false },
  { id: "change", label: "Code change recorded after reproduction", passed: false },
  { id: "passing-verification", label: "Verification passed after the change", passed: false },
  { id: "changed-node-executed", label: "Changed code executed during verification", passed: false }
];

const EVENT_LABELS: Readonly<Record<string, string>> = {
  "task.started": "Task started",
  "agent.prompted": "Prompt submitted",
  "node.inspected": "Code inspected",
  "tool.completed": "Command completed",
  "tool.failed": "Command failed",
  "agent.stopped": "Agent turn stopped",
  "test.started": "Tests started",
  "node.executed": "Code path executed",
  "test.completed": "Tests completed",
  "diagnosis.recorded": "Cause recorded",
  "file.changed": "Code changed",
  "verification.passed": "Proof verified",
  "verification.failed": "Proof rejected",
  "task.completed": "Task completed",
  "task.blocked": "Completion blocked"
};

interface InspectorState {
  title: string;
  detail: string;
  values: ReadonlyArray<readonly [string, string]>;
}

const DEFAULT_INSPECTOR: InspectorState = {
  title: "Select evidence",
  detail: "Choose a graph node or ledger event to inspect its recorded context.",
  values: []
};

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
  return response.json() as Promise<T>;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function truncate(value: unknown, limit: number): string {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function eventDetail(event: LedgerEvent): string {
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
  const reproduction = events.find(
    (event) => event.type === "test.completed" && event.status === "failed" && event.data.stage === "reproduce"
  );
  const change = events.find(
    (event) => event.type === "file.changed" && event.seq > (reproduction?.seq ?? Number.MAX_SAFE_INTEGER)
  );
  const changedNodeIds = new Set(change?.nodeIds ?? []);
  const execution = events.find(
    (event) => event.type === "node.executed" && event.seq > (change?.seq ?? Number.MAX_SAFE_INTEGER) &&
      event.nodeIds.some((nodeId) => changedNodeIds.has(nodeId))
  );
  const verification = events.find(
    (event) => event.type === "test.completed" && event.status === "passed" &&
      event.data.stage === "verify" && event.seq > (change?.seq ?? Number.MAX_SAFE_INTEGER)
  );
  return EMPTY_CHECKS.map((check) => ({
    ...check,
    passed: check.id === "reproduction"
      ? Boolean(reproduction)
      : check.id === "change"
        ? Boolean(change)
        : check.id === "passing-verification"
          ? Boolean(verification)
          : Boolean(execution)
  }));
}

export function DashboardApp(): JSX.Element {
  const [graph, setGraph] = useState<RepositoryGraph>(EMPTY_GRAPH);
  const [runs, setRuns] = useState<ProofRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [proof, setProof] = useState<ProofResult | null>(null);
  const [mode, setMode] = useState<GraphMode>("proof");
  const [replayCount, setReplayCount] = useState<number | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [inspector, setInspector] = useState<InspectorState>(DEFAULT_INSPECTOR);
  const [error, setError] = useState<string | null>(null);

  const run = useMemo(
    () => runs.find((candidate) => candidate.id === selectedRunId) ?? null,
    [runs, selectedRunId]
  );
  const visibleEvents = replayCount === null ? events : events.slice(0, replayCount);
  const replaying = replayCount !== null;
  const replayCompleted = visibleEvents.some((event) => event.type === "task.completed");
  const replayBlocked = visibleEvents.some((event) => event.type === "task.blocked");
  const displayedRun = replaying && run
    ? { ...run, status: replayCompleted ? "completed" as const : replayBlocked ? "blocked" as const : "running" as const }
    : run;
  const checks = replaying ? progressiveChecks(visibleEvents) : proof?.checks ?? EMPTY_CHECKS;
  const passedChecks = checks.filter((check) => check.passed).length;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchJson<RepositoryGraph>("/api/graph"),
      fetchJson<ProofRun[]>("/api/runs")
    ]).then(([nextGraph, nextRuns]) => {
      if (cancelled) return;
      setGraph(nextGraph);
      setRuns(nextRuns);
      setSelectedRunId((current) => current || nextRuns[0]?.id || "");
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedRunId) {
      setEvents([]);
      setProof(null);
      return;
    }
    let cancelled = false;
    setReplayCount(null);
    setSelectedNodeId(null);
    setInspector(DEFAULT_INSPECTOR);

    Promise.all([
      fetchJson<LedgerEvent[]>(`/api/events?runId=${encodeURIComponent(selectedRunId)}`),
      fetchJson<ProofResult>(`/api/proof?runId=${encodeURIComponent(selectedRunId)}`)
    ]).then(([nextEvents, nextProof]) => {
      if (cancelled) return;
      setEvents(nextEvents);
      setProof(nextProof);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });

    const stream = new EventSource(`/api/stream?runId=${encodeURIComponent(selectedRunId)}`);
    const onProofEvent = (message: MessageEvent<string>): void => {
      const event = JSON.parse(message.data) as LedgerEvent;
      setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event]);
      void Promise.all([
        fetchJson<ProofRun[]>("/api/runs"),
        fetchJson<ProofResult>(`/api/proof?runId=${encodeURIComponent(selectedRunId)}`)
      ]).then(([nextRuns, nextProof]) => {
        if (cancelled) return;
        setRuns(nextRuns);
        setProof(nextProof);
      });
    };
    stream.addEventListener("proof-event", onProofEvent as EventListener);

    return () => {
      cancelled = true;
      stream.removeEventListener("proof-event", onProofEvent as EventListener);
      stream.close();
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (replayCount === null) return;
    if (replayCount >= events.length) {
      const completion = window.setTimeout(() => setReplayCount(null), 500);
      return () => window.clearTimeout(completion);
    }
    const timer = window.setTimeout(() => setReplayCount((current) => current === null ? null : current + 1), 560);
    return () => window.clearTimeout(timer);
  }, [events.length, replayCount]);

  const inspectNode = useCallback((node: DisplayNode): void => {
    setSelectedNodeId(node.id);
    const summary = typeof node.data?.summary === "string" ? node.data.summary : undefined;
    setInspector({
      title: node.label,
      detail: summary ?? (node.file ? `${node.file}${node.line ? `:${node.line}` : ""}` : `${node.kicker} evidence node`),
      values: [
        ["Status", node.status],
        ...(node.file ? [["File", node.file] as const] : []),
        ...(node.line ? [["Line", String(node.line)] as const] : []),
        ...(node.event ? [["Event", node.event.type] as const] : [])
      ]
    });
  }, []);

  const inspectEvent = useCallback((event: LedgerEvent): void => {
    setSelectedNodeId(null);
    setInspector({
      title: EVENT_LABELS[event.type] ?? event.type,
      detail: eventDetail(event),
      values: [
        ["Sequence", String(event.seq)],
        ["Status", event.status],
        ["Time", formatTime(event.timestamp)],
        ["Nodes", String(event.nodeIds.length)],
        ...(typeof event.data.stage === "string" ? [["Stage", event.data.stage] as const] : []),
        ...(typeof event.data.exitCode === "number" ? [["Exit code", String(event.data.exitCode)] as const] : [])
      ]
    });
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">P/R</span>
          <div>
            <strong>Proof &amp; Replay</strong>
            <span>Evidence for AI-written code</span>
          </div>
        </div>
        <div className="topbar__actions">
          <a className="author" href="mailto:raykundan57@gmail.com">
            <span>Kundan Ray</span>
            <small>raykundan57@gmail.com</small>
          </a>
          <Badge tone="live" dot>Live</Badge>
          <Select
            label="Select proof run"
            compact
            value={selectedRunId}
            onChange={(event) => setSelectedRunId(event.currentTarget.value)}
            disabled={runs.length === 0}
          >
            {runs.length === 0 ? <option value="">No runs recorded</option> : null}
            {runs.map((item) => (
              <option key={item.id} value={item.id}>
                {item.status === "completed" ? "✓" : item.status === "blocked" ? "×" : "•"} {truncate(item.prompt, 36)}
              </option>
            ))}
          </Select>
        </div>
      </header>

      <main className="page">
        {error ? <div className="error-banner" role="alert">Dashboard error: {error}</div> : null}
        <section className="task-summary" aria-labelledby="task-heading">
          <div>
            <p className="eyebrow">Selected task</p>
            <h1 id="task-heading">{run?.prompt ?? "Waiting for a recorded task"}</h1>
            <p className="task-summary__meta">
              {run
                ? `${run.id} · started ${formatTime(run.createdAt)} · ${displayedRun?.status ?? run.status}`
                : "Start a run to see its evidence path."}
            </p>
          </div>
          <div className="proof-score" aria-label={`${passedChecks} of ${checks.length} proof checks passed`}>
            <span>{passedChecks}/{checks.length}</span>
            <small>proof checks</small>
          </div>
        </section>

        <div className="workspace">
          <Panel className="ledger-panel" aria-labelledby="ledger-heading">
            <PanelHeader
              eyebrow="Append-only ledger"
              title="Execution"
              titleId="ledger-heading"
              action={<span className="event-count">{visibleEvents.length}</span>}
            />
            <ol className="timeline">
              {[...visibleEvents].reverse().map((event) => (
                <li key={event.id} className={`timeline__item timeline__item--${event.status}`}>
                  <button type="button" onClick={() => inspectEvent(event)}>
                    <strong>{EVENT_LABELS[event.type] ?? event.type}</strong>
                    <span>{formatTime(event.timestamp)} · {truncate(eventDetail(event), 36)}</span>
                  </button>
                </li>
              ))}
            </ol>
          </Panel>

          <Panel className="graph-panel" aria-labelledby="graph-heading">
            <div className="graph-toolbar">
              <div>
                <p className="eyebrow">Causal view</p>
                <h2 id="graph-heading">{mode === "proof" ? "Proof graph" : "Activated code map"}</h2>
              </div>
              <SegmentedControl
                label="Graph view"
                value={mode}
                options={[{ value: "proof", label: "Proof" }, { value: "code", label: "Code" }]}
                onChange={setMode}
              />
              <Button
                variant="secondary"
                size="small"
                busy={replaying}
                leadingIcon={<PlayIcon />}
                onClick={() => setReplayCount(0)}
                disabled={events.length === 0}
              >
                {replaying ? "Replaying" : "Replay run"}
              </Button>
            </div>
            <GraphCanvas
              mode={mode}
              graph={graph}
              events={visibleEvents}
              selectedNodeId={selectedNodeId}
              onSelectNode={inspectNode}
            />
            <div className="legend" aria-label="Graph status legend">
              {(["planned", "active", "passed", "changed", "failed"] as const).map((status) => (
                <span key={status}><i className={`legend__dot legend__dot--${status}`} />{status === "passed" ? "Verified" : status}</span>
              ))}
            </div>
          </Panel>

          <Panel className="proof-panel" aria-labelledby="proof-heading">
            <PanelHeader
              eyebrow="Completion contract"
              title="Proof"
              titleId="proof-heading"
              action={<Badge tone={proofTone(displayedRun)}>{proofLabel(displayedRun)}</Badge>}
            />
            <ul className="proof-checks">
              {checks.map((check) => (
                <li key={check.id} className={check.passed ? "is-passed" : displayedRun?.status === "blocked" ? "is-failed" : ""}>
                  <span className="proof-checks__icon" aria-hidden="true">{check.passed ? "✓" : displayedRun?.status === "blocked" ? "×" : "○"}</span>
                  <span>{check.label}</span>
                </li>
              ))}
            </ul>
            <div className="inspector">
              <p className="eyebrow">Selected evidence</p>
              <h3>{inspector.title}</h3>
              <p>{inspector.detail}</p>
              <dl>
                {inspector.values.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </Panel>
        </div>
      </main>
      <footer className="footer">
        <span>Proof &amp; Replay</span>
        <span>Created by Kundan Ray · <a href="mailto:raykundan57@gmail.com">raykundan57@gmail.com</a></span>
      </footer>
    </div>
  );
}
