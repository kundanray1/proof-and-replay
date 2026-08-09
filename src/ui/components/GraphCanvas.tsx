import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type {
  EventStatus,
  GraphNode,
  LedgerEvent,
  NodeKind,
  RepositoryGraph
} from "../../types.js";
import { EmptyState } from "./primitives.js";

export type GraphMode = "proof" | "code";

export interface DisplayNode {
  id: string;
  label: string;
  kicker: string;
  status: EventStatus;
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
  onSelectNode: (node: DisplayNode) => void;
}

function firstEvent(
  events: readonly LedgerEvent[],
  type: string,
  predicate: (event: LedgerEvent) => boolean = () => true
): LedgerEvent | undefined {
  return events.find((event) => event.type === type && predicate(event));
}

function proofGraph(events: readonly LedgerEvent[]): DisplayGraph {
  const started = firstEvent(events, "task.started");
  const reproduction = firstEvent(events, "test.completed", (event) => event.data.stage === "reproduce");
  const diagnosis = firstEvent(events, "diagnosis.recorded");
  const change = firstEvent(events, "file.changed");
  const verification = firstEvent(events, "verification.passed") ?? firstEvent(events, "verification.failed");
  const completion = firstEvent(events, "task.completed") ?? firstEvent(events, "task.blocked");
  const nodes: DisplayNode[] = [
    { id: "intent", label: "Task accepted", kicker: "Intent", event: started, status: started ? "passed" : "planned" },
    { id: "reproduce", label: "Failure reproduced", kicker: "Evidence", event: reproduction, status: reproduction ? (reproduction.status === "failed" ? "passed" : reproduction.status) : "planned" },
    { id: "diagnose", label: "Cause isolated", kicker: "Diagnosis", event: diagnosis, status: diagnosis ? "observed" : "planned" },
    { id: "change", label: "Code modified", kicker: "Change", event: change, status: change ? "changed" : "planned" },
    { id: "verify", label: "Tests verify fix", kicker: "Verification", event: verification, status: verification?.status ?? (change ? "active" : "planned") },
    { id: "complete", label: "Completion allowed", kicker: "Outcome", event: completion, status: completion?.status ?? "planned" }
  ];
  return {
    nodes,
    edges: nodes.slice(1).map((node, index) => ({ source: nodes[index]!.id, target: node.id }))
  };
}

function codeGraph(graph: RepositoryGraph, events: readonly LedgerEvent[]): DisplayGraph {
  const statuses = new Map<string, EventStatus>();
  const touched = new Set<string>();
  for (const event of events) {
    for (const nodeId of event.nodeIds) {
      touched.add(nodeId);
      statuses.set(nodeId, event.status);
    }
  }
  const related = new Set(touched);
  for (const edge of graph.edges) {
    if (touched.has(edge.source) || touched.has(edge.target)) {
      related.add(edge.source);
      related.add(edge.target);
    }
  }
  const sourceNodes = related.size > 0
    ? graph.nodes.filter((node) => related.has(node.id))
    : graph.nodes.slice(0, 60);
  const allowed = new Set(sourceNodes.map((node) => node.id));
  return {
    nodes: sourceNodes.map((node: GraphNode) => ({
      ...node,
      kicker: node.kind,
      status: statuses.get(node.id) ?? "planned"
    })),
    edges: graph.edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target))
  };
}

function proofLayout(graph: DisplayGraph, width: number, height: number): PositionedNode[] {
  const columns = width >= 760 ? 3 : 2;
  const rows = Math.ceil(graph.nodes.length / columns);
  const xGap = width / columns;
  const yGap = Math.min(180, Math.max(130, (height - 100) / rows));
  return graph.nodes.map((node, index) => ({
    ...node,
    x: xGap * (index % columns) + xGap / 2,
    y: 90 + Math.floor(index / columns) * yGap
  }));
}

function codeLayout(graph: DisplayGraph, width: number, height: number): PositionedNode[] {
  const groups: Record<NodeKind, DisplayNode[]> = { file: [], function: [], test: [] };
  for (const node of graph.nodes) groups[node.kind ?? "function"].push(node);
  const columns = [groups.file, groups.function, groups.test].filter((group) => group.length > 0);
  const positions: PositionedNode[] = [];
  columns.forEach((group, columnIndex) => {
    const visible = group.slice(0, 12);
    const x = ((columnIndex + 1) * width) / (columns.length + 1);
    visible.forEach((node, rowIndex) => {
      positions.push({
        ...node,
        x,
        y: ((rowIndex + 1) * (height - 60)) / (visible.length + 1) + 30
      });
    });
  });
  return positions;
}

function activateWithKeyboard(event: KeyboardEvent<SVGGElement>, action: () => void): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

export function GraphCanvas({
  mode,
  graph,
  events,
  selectedNodeId,
  onSelectNode
}: GraphCanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 720, height: 520 });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({
        width: Math.max(440, Math.round(entry.contentRect.width)),
        height: Math.max(460, Math.round(entry.contentRect.height))
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const displayGraph = useMemo(
    () => mode === "proof" ? proofGraph(events) : codeGraph(graph, events),
    [events, graph, mode]
  );
  const nodes = useMemo(
    () => mode === "proof"
      ? proofLayout(displayGraph, size.width, size.height)
      : codeLayout(displayGraph, size.width, size.height),
    [displayGraph, mode, size]
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return (
    <div className="graph-canvas" ref={containerRef}>
      <svg viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-labelledby="graph-heading graph-description">
        <desc id="graph-description">Task evidence and code paths activated by the selected agent run.</desc>
        <defs>
          <marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="graph-arrow" />
          </marker>
        </defs>
        {displayGraph.edges.map((edge) => {
          const source = byId.get(edge.source);
          const target = byId.get(edge.target);
          if (!source || !target) return null;
          const direction = target.x >= source.x ? 1 : -1;
          const sourceX = source.x + direction * 80;
          const targetX = target.x - direction * 80;
          const middle = (sourceX + targetX) / 2;
          const active = source.status === "active" || target.status === "active";
          return (
            <path
              key={`${edge.source}:${edge.target}`}
              d={`M ${sourceX} ${source.y} C ${middle} ${source.y}, ${middle} ${target.y}, ${targetX} ${target.y}`}
              className={`graph-edge ${active ? "is-active" : ""}`}
              markerEnd="url(#graph-arrow)"
            />
          );
        })}
        {nodes.map((node) => (
          <g
            key={node.id}
            transform={`translate(${node.x - 80} ${node.y - 30})`}
            className={`graph-node graph-node--${node.status} ${selectedNodeId === node.id ? "is-selected" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={`${node.label}, ${node.status}`}
            onClick={() => onSelectNode(node)}
            onKeyDown={(event) => activateWithKeyboard(event, () => onSelectNode(node))}
          >
            <rect width="160" height="60" rx="10" />
            <circle className="graph-node__status" cx="18" cy="19" r="5" />
            <text className="graph-node__kicker" x="31" y="22">{node.kicker.toUpperCase()}</text>
            <text className="graph-node__label" x="15" y="43">{node.label.length > 23 ? `${node.label.slice(0, 22)}…` : node.label}</text>
          </g>
        ))}
      </svg>
      {displayGraph.nodes.length === 0 ? (
        <EmptyState title="No execution recorded" description="Agent and test events will activate this graph in real time." />
      ) : null}
    </div>
  );
}
