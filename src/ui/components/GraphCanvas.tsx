import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { EventStatus, GraphNode, LedgerEvent, NodeKind, RepositoryGraph } from "../../types.js";
import { EmptyState } from "./primitives.js";

export type GraphMode = "model" | "scenario" | "routes" | "proof";

export interface DisplayNode {
  id: string;
  label: string;
  kicker: string;
  status: EventStatus;
  subtitle?: string;
  file?: string;
  line?: number;
  data?: Record<string, unknown>;
  event?: LedgerEvent | undefined;
  kind?: NodeKind;
}

interface PositionedNode extends DisplayNode {
  x: number;
  y: number;
}

interface DisplayEdge {
  source: string;
  target: string;
  active?: boolean;
}

interface DisplayGraph {
  nodes: DisplayNode[];
  edges: DisplayEdge[];
}

export interface GraphCanvasProps {
  mode: GraphMode;
  graph: RepositoryGraph;
  events: readonly LedgerEvent[];
  selectedNodeId: string | null;
  selectedProjectId: string | null;
  onSelectNode: (node: DisplayNode) => void;
  onOpenNode: (node: DisplayNode) => void;
}

const NODE_WIDTH = 184;
const NODE_HEIGHT = 70;

function shorten(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function firstEvent(events: readonly LedgerEvent[], type: string, predicate: (event: LedgerEvent) => boolean = () => true): LedgerEvent | undefined {
  return events.find((event) => event.type === type && predicate(event));
}

function eventStatuses(graph: RepositoryGraph, events: readonly LedgerEvent[]): Map<string, EventStatus> {
  const statuses = new Map<string, EventStatus>();
  for (const event of events) {
    for (const id of event.nodeIds) statuses.set(id, event.status);
    const command = typeof event.data.command === "string" ? event.data.command : "";
    if (!command) continue;
    for (const project of graph.architecture?.projects ?? []) {
      if (project.path !== "." && command.includes(project.path)) statuses.set(project.id, event.status);
    }
    for (const node of graph.nodes) {
      if (node.kind === "file" && command.includes(node.file)) {
        statuses.set(node.id, event.status);
        if (typeof node.data.projectId === "string") statuses.set(node.data.projectId, event.status);
      }
    }
  }
  return statuses;
}

function asDisplayNode(node: GraphNode, statuses: ReadonlyMap<string, EventStatus>): DisplayNode {
  const stats = node.kind === "project" ? node.data.stats : null;
  const subtitle = node.kind === "route"
    ? String(node.data.handlerNames instanceof Array && node.data.handlerNames.length > 0 ? node.data.handlerNames.join(", ") : node.file)
    : node.kind === "project" && stats && typeof stats === "object"
      ? "Project boundary"
      : node.file === "." ? String(node.data.projectKind ?? "repository") : node.file;
  return { ...node, kicker: node.kind, subtitle, status: statuses.get(node.id) ?? "planned" };
}

function proofGraph(events: readonly LedgerEvent[]): DisplayGraph {
  const started = firstEvent(events, "task.started");
  const reproduction = firstEvent(events, "test.completed", (event) => event.data.stage === "reproduce");
  const diagnosis = firstEvent(events, "diagnosis.recorded");
  const change = firstEvent(events, "file.changed");
  const verification = firstEvent(events, "verification.passed") ?? firstEvent(events, "verification.failed");
  const completion = firstEvent(events, "task.completed") ?? firstEvent(events, "task.blocked");
  const nodes: DisplayNode[] = [
    { id: "intent", label: "Task accepted", kicker: "Intent", event: started, status: started ? "passed" : "planned", subtitle: "Agent received the task" },
    { id: "reproduce", label: "Failure reproduced", kicker: "Evidence", event: reproduction, status: reproduction ? (reproduction.status === "failed" ? "passed" : reproduction.status) : "planned", subtitle: "Original behavior captured" },
    { id: "diagnose", label: "Cause isolated", kicker: "Diagnosis", event: diagnosis, status: diagnosis ? "observed" : "planned", subtitle: "Reason recorded" },
    { id: "change", label: "Code modified", kicker: "Change", event: change, status: change ? "changed" : "planned", subtitle: "Changed nodes identified" },
    { id: "verify", label: "Tests verify fix", kicker: "Verification", event: verification, status: verification?.status ?? (change ? "active" : "planned"), subtitle: "Post-change check" },
    { id: "complete", label: "Completion allowed", kicker: "Outcome", event: completion, status: completion?.status ?? "planned", subtitle: "Proof contract satisfied" }
  ];
  return { nodes, edges: nodes.slice(1).map((node, index) => ({ source: nodes[index]!.id, target: node.id, active: Boolean(node.event) })) };
}

function modelGraph(graph: RepositoryGraph, events: readonly LedgerEvent[], selectedProjectId: string | null): DisplayGraph {
  const statuses = eventStatuses(graph, events);
  const architecture = graph.architecture;
  if (!architecture) return { nodes: [], edges: [] };
  if (!selectedProjectId) {
    const nodes = architecture.projects.map((project) => {
      const source = graph.nodes.find((node) => node.id === project.id)!;
      return {
        ...asDisplayNode(source, statuses),
        subtitle: `${project.stats.files} files · ${project.stats.routes} routes`
      };
    });
    const allowed = new Set(nodes.map((node) => node.id));
    const edges = graph.edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)).map((edge) => ({
      source: edge.source, target: edge.target, active: statuses.has(edge.source) || statuses.has(edge.target)
    }));
    return { nodes, edges };
  }

  const project = architecture.projects.find((candidate) => candidate.id === selectedProjectId);
  if (!project) return { nodes: [], edges: [] };
  const owned = graph.nodes.filter((node) => node.data.projectId === project.id);
  const routeIds = new Set(architecture.routes.filter((route) => route.projectId === project.id).map((route) => route.id));
  const activeIds = new Set([...statuses.keys()]);
  const connected = new Set<string>([project.id, ...routeIds, ...project.entryNodeIds, ...activeIds]);
  for (const edge of graph.edges) {
    if (connected.has(edge.source) || connected.has(edge.target)) {
      connected.add(edge.source);
      connected.add(edge.target);
    }
  }
  const priority = (node: GraphNode): number => activeIds.has(node.id) ? 0 : node.kind === "route" ? 1 : project.entryNodeIds.includes(node.id) ? 2 : node.kind === "file" ? 3 : 4;
  const details = owned.filter((node) => connected.has(node.id)).sort((left, right) => priority(left) - priority(right)).slice(0, 38);
  const sourceNodes = [graph.nodes.find((node) => node.id === project.id)!, ...details];
  const allowed = new Set(sourceNodes.map((node) => node.id));
  return {
    nodes: sourceNodes.map((node) => asDisplayNode(node, statuses)),
    edges: graph.edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)).map((edge) => ({ source: edge.source, target: edge.target, active: statuses.has(edge.source) || statuses.has(edge.target) }))
  };
}

function routesGraph(graph: RepositoryGraph, events: readonly LedgerEvent[], selectedProjectId: string | null, selectedNodeId: string | null): DisplayGraph {
  const statuses = eventStatuses(graph, events);
  const selectedRoute = selectedNodeId ? graph.architecture?.routes.find((route) => route.id === selectedNodeId) : undefined;
  const routes = selectedRoute
    ? [selectedRoute]
    : (graph.architecture?.routes ?? []).filter((route) => !selectedProjectId || route.projectId === selectedProjectId).slice(0, 80);
  const ids = new Set(routes.map((route) => route.id));
  for (const edge of graph.edges) {
    if (ids.has(edge.source) && edge.kind === "handles") ids.add(edge.target);
  }
  if (selectedRoute) {
    for (let depth = 0; depth < 2; depth += 1) {
      for (const edge of graph.edges) {
        if (ids.has(edge.source) && ["calls", "imports", "requests"].includes(edge.kind)) ids.add(edge.target);
      }
    }
  }
  const sourceNodes = graph.nodes.filter((node) => ids.has(node.id));
  return {
    nodes: sourceNodes.map((node) => asDisplayNode(node, statuses)),
    edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target) && ["handles", "requests"].includes(edge.kind)).map((edge) => ({ source: edge.source, target: edge.target, active: statuses.has(edge.source) || statuses.has(edge.target) }))
  };
}

function eventProject(graph: RepositoryGraph, event: LedgerEvent): string | null {
  for (const id of event.nodeIds) {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (node?.kind === "project") return node.id;
    if (typeof node?.data.projectId === "string") return node.data.projectId;
  }
  const command = typeof event.data.command === "string" ? event.data.command : "";
  const matches = (graph.architecture?.projects ?? []).filter((project) => project.path !== "." && command.includes(project.path));
  return matches.sort((left, right) => right.path.length - left.path.length)[0]?.id ?? null;
}

function scenarioGraph(graph: RepositoryGraph, events: readonly LedgerEvent[], selectedProjectId: string | null): DisplayGraph {
  const ignored = new Set(["usage.sampled", "agent.stopped"]);
  const candidates = events.filter((event) => !ignored.has(event.type)).map((event) => {
    const projectId = eventProject(graph, event);
    const project = graph.architecture?.projects.find((item) => item.id === projectId);
    return { event, projectId, project };
  }).filter((item) => !selectedProjectId || item.projectId === selectedProjectId);

  const grouped: Array<{ events: LedgerEvent[]; projectId: string | null; projectName: string }> = [];
  for (const item of candidates) {
    const projectName = item.project?.name ?? "Repository";
    const previous = grouped.at(-1);
    const key = `${item.projectId ?? "root"}:${item.event.type}:${item.event.status}`;
    const previousKey = previous ? `${previous.projectId ?? "root"}:${previous.events[0]!.type}:${previous.events[0]!.status}` : "";
    if (previous && key === previousKey) previous.events.push(item.event);
    else grouped.push({ events: [item.event], projectId: item.projectId, projectName });
  }
  const visible = grouped.slice(-30);
  const nodes: DisplayNode[] = visible.map((group) => {
    const event = group.events.at(-1)!;
    const repeat = group.events.length > 1 ? ` ×${group.events.length}` : "";
    const verb = event.type === "file.changed" ? "Code changed" : event.type === "test.completed" ? "Tests completed" : event.type === "node.inspected" ? "Code inspected" : event.type === "task.started" ? "Task started" : event.type === "agent.prompted" ? "Agent prompted" : event.type === "tool.failed" ? "Command failed" : "Command ran";
    return {
      id: `scenario:${group.events[0]!.id}`,
      label: `${group.projectName} · ${verb}${repeat}`,
      kicker: `Step ${event.seq}`,
      subtitle: typeof event.data.command === "string" ? shorten(event.data.command, 44) : typeof event.data.files === "object" ? String(event.data.files) : event.status,
      status: event.status,
      event,
      data: { projectId: group.projectId, eventCount: group.events.length }
    };
  });
  return { nodes, edges: nodes.slice(1).map((node, index) => ({ source: nodes[index]!.id, target: node.id, active: true })) };
}

function layout(graph: DisplayGraph, mode: GraphMode, width: number, height: number): PositionedNode[] {
  if (mode === "scenario") {
    const columns = Math.max(1, Math.min(4, Math.floor((width - 80) / 220)));
    const rowGap = 125;
    return graph.nodes.map((node, index) => {
      const row = Math.floor(index / columns);
      const offset = index % columns;
      const column = row % 2 === 0 ? offset : columns - offset - 1;
      return { ...node, x: 120 + column * ((width - 240) / Math.max(1, columns - 1)), y: 85 + row * rowGap };
    });
  }
  if (mode === "proof") {
    const columns = width >= 760 ? 3 : 2;
    return graph.nodes.map((node, index) => ({ ...node, x: ((index % columns) + 0.5) * (width / columns), y: 100 + Math.floor(index / columns) * 190 }));
  }
  if (mode === "model" && graph.nodes.length > 1 && graph.nodes.every((node) => node.kind === "project")) {
    const root = graph.nodes.find((node) => node.file === ".") ?? graph.nodes[0]!;
    const children = graph.nodes.filter((node) => node.id !== root.id);
    const columns = Math.min(3, children.length);
    return [
      { ...root, x: width / 2, y: 75 },
      ...children.map((node, index) => ({
        ...node,
        x: ((index % columns) + 0.5) * (width / columns),
        y: 220 + Math.floor(index / columns) * 130
      }))
    ];
  }
  const order: NodeKind[] = ["project", "route", "file", "function", "test"];
  const groups = order.map((kind) => graph.nodes.filter((node) => node.kind === kind)).filter((group) => group.length > 0);
  const positions: PositionedNode[] = [];
  groups.forEach((group, columnIndex) => {
    const x = ((columnIndex + 1) * width) / (groups.length + 1);
    const gap = Math.max(92, Math.min(112, (height - 100) / Math.max(1, group.length)));
    group.forEach((node, rowIndex) => positions.push({ ...node, x, y: 70 + rowIndex * gap }));
  });
  return positions;
}

function activateWithKeyboard(event: KeyboardEvent<SVGGElement>, action: () => void): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

export function GraphCanvas({ mode, graph, events, selectedNodeId, selectedProjectId, onSelectNode, onOpenNode }: GraphCanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 580 });
  const [zoom, setZoom] = useState(1);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ width: Math.max(520, Math.round(entry.contentRect.width)), height: Math.max(520, Math.round(entry.contentRect.height)) });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => setZoom(1), [mode, selectedProjectId]);
  const displayGraph = useMemo(() => mode === "proof" ? proofGraph(events) : mode === "model" ? modelGraph(graph, events, selectedProjectId) : mode === "routes" ? routesGraph(graph, events, selectedProjectId, selectedNodeId) : scenarioGraph(graph, events, selectedProjectId), [events, graph, mode, selectedNodeId, selectedProjectId]);
  const canvasHeight = Math.max(size.height, mode === "scenario" ? Math.ceil(displayGraph.nodes.length / Math.max(1, Math.min(4, Math.floor((size.width - 80) / 220)))) * 125 + 90 : Math.max(1, ...(["project", "route", "file", "function", "test"] as NodeKind[]).map((kind) => displayGraph.nodes.filter((node) => node.kind === kind).length)) * 108 + 90);
  const nodes = useMemo(() => layout(displayGraph, mode, size.width, canvasHeight), [canvasHeight, displayGraph, mode, size.width]);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const selected = selectedNodeId ? byId.get(selectedNodeId) : undefined;
  const viewportWidth = size.width / zoom;
  const viewportHeight = size.height / zoom;
  const centerX = selected?.x ?? size.width / 2;
  const centerY = selected?.y ?? Math.min(canvasHeight / 2, size.height / 2);
  const viewX = Math.max(0, Math.min(Math.max(0, size.width - viewportWidth), centerX - viewportWidth / 2));
  const viewY = Math.max(0, Math.min(Math.max(0, canvasHeight - viewportHeight), centerY - viewportHeight / 2));

  return (
    <div className="graph-canvas" ref={containerRef}>
      <div className="zoom-controls" aria-label="Graph zoom controls">
        <button type="button" onClick={() => setZoom((value) => Math.min(2.2, value + 0.2))} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => setZoom((value) => Math.max(0.7, value - 0.2))} aria-label="Zoom out">−</button>
        <button type="button" onClick={() => setZoom(1)}>Fit</button>
        <span>{Math.round(zoom * 100)}%</span>
      </div>
      <svg viewBox={`${viewX} ${viewY} ${viewportWidth} ${viewportHeight}`} role="img" aria-labelledby="graph-heading graph-description">
        <desc id="graph-description">Repository architecture, routes, functions, and paths activated by the selected agent run.</desc>
        <defs>
          <marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="graph-arrow" />
          </marker>
        </defs>
        {displayGraph.edges.map((edge, index) => {
          const source = byId.get(edge.source);
          const target = byId.get(edge.target);
          if (!source || !target) return null;
          const direction = target.x >= source.x ? 1 : -1;
          const sourceX = source.x + direction * (NODE_WIDTH / 2);
          const targetX = target.x - direction * (NODE_WIDTH / 2);
          const middle = (sourceX + targetX) / 2;
          return <path key={`${edge.source}:${edge.target}:${index}`} d={`M ${sourceX} ${source.y} C ${middle} ${source.y}, ${middle} ${target.y}, ${targetX} ${target.y}`} className={`graph-edge ${edge.active ? "is-active" : ""}`} markerEnd="url(#graph-arrow)" />;
        })}
        {nodes.map((node) => (
          <g key={node.id} transform={`translate(${node.x - NODE_WIDTH / 2} ${node.y - NODE_HEIGHT / 2})`} className={`graph-node graph-node--${node.status} graph-node--kind-${node.kind ?? "evidence"} ${selectedNodeId === node.id ? "is-selected" : ""}`} role="button" tabIndex={0} aria-label={`${node.label}, ${node.status}`} onClick={() => onSelectNode(node)} onDoubleClick={() => onOpenNode(node)} onKeyDown={(event) => activateWithKeyboard(event, () => onSelectNode(node))}>
            <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx="10" />
            <circle className="graph-node__status" cx="17" cy="18" r="4.5" />
            <text className="graph-node__kicker" x="29" y="21">{shorten(node.kicker.toUpperCase(), 24)}</text>
            <text className="graph-node__label" x="14" y="43">{shorten(node.label, 27)}</text>
            {node.subtitle ? <text className="graph-node__subtitle" x="14" y="59">{shorten(node.subtitle, 31)}</text> : null}
          </g>
        ))}
      </svg>
      {displayGraph.nodes.length === 0 ? <EmptyState title="No map available" description="Scan the repository to build its project, route, file, and function model." /> : null}
    </div>
  );
}
