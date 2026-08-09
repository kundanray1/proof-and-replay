import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import type { DeliverySnapshot, EventStatus, GraphEdge, GraphNode, LedgerEvent, NodeKind, RepositoryGraph } from "../../types.js";
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

export interface PositionedNode extends DisplayNode {
  x: number;
  y: number;
}

export interface DisplayEdge {
  id?: string;
  source: string;
  target: string;
  kind: string;
  label: string;
  active?: boolean;
  data?: Record<string, unknown>;
}

export interface DisplayGraph {
  nodes: DisplayNode[];
  edges: DisplayEdge[];
  lanes?: Array<{ id: string; label: string }>;
}

interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

interface ContextBubble {
  label: string;
  detail: string;
}

interface PositionedBubble extends ContextBubble {
  x: number;
  y: number;
}

export interface GraphFocus {
  directNodeIds: Set<string>;
  secondaryNodeIds: Set<string>;
  directEdgeIds: Set<string>;
  secondaryEdgeIds: Set<string>;
}

export interface GraphCanvasProps {
  mode: GraphMode;
  graph: RepositoryGraph;
  events: readonly LedgerEvent[];
  selectedNodeId: string | null;
  selectedProjectId: string | null;
  onSelectNode: (node: DisplayNode) => void;
  onOpenNode: (node: DisplayNode) => void;
  onClearSelection: () => void;
  delivery: DeliverySnapshot | null;
  traceView: "exploration" | "delivery";
}

const NODE_WIDTH = 210;
const NODE_HEIGHT = 86;
const BUBBLE_WIDTH = 156;
const BUBBLE_HEIGHT = 44;
const MIN_SCALE = 0.3;
const MAX_SCALE = 2.8;

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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asDisplayNode(node: GraphNode, statuses: ReadonlyMap<string, EventStatus>): DisplayNode {
  const stats = node.kind === "project" && node.data.stats && typeof node.data.stats === "object" ? node.data.stats as Record<string, unknown> : null;
  const fields = stringArray(node.data.fields);
  const parameters = stringArray(node.data.parameters);
  const subtitle = node.kind === "route"
    ? String(stringArray(node.data.handlerNames).join(", ") || node.file)
    : node.kind === "data"
      ? `${String(node.data.modelKind ?? "model")} · ${fields.length} field${fields.length === 1 ? "" : "s"}`
      : node.kind === "function" || node.kind === "test"
        ? parameters.length > 0 ? `(${parameters.join(", ")})` : `${node.file}:${node.line}`
        : node.kind === "project" && stats
          ? `${Number(stats.files ?? 0)} files · ${Number(stats.functions ?? 0)} functions · ${Number(stats.routes ?? 0)} routes`
          : node.file === "." ? String(node.data.projectKind ?? "repository") : node.file;
  return { ...node, kicker: node.kind, subtitle, status: statuses.get(node.id) ?? "planned" };
}

function edgeLabel(edge: GraphEdge): string {
  if (edge.kind === "depends-on" && typeof edge.data.count === "number") return `${edge.data.count} imports`;
  if (edge.kind === "calls" && Array.isArray(edge.data.arguments)) return `calls · ${edge.data.arguments.length} args`;
  return edge.kind.replaceAll("-", " ");
}

function displayEdge(edge: GraphEdge, statuses: ReadonlyMap<string, EventStatus>): DisplayEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    label: edgeLabel(edge),
    active: statuses.has(edge.source) || statuses.has(edge.target),
    data: edge.data
  };
}

function edgeIdentity(edge: Pick<DisplayEdge, "source" | "target" | "kind">): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.kind}`;
}

export function connectedNeighborhood(edges: readonly DisplayEdge[], selectedNodeId: string | null): GraphFocus {
  const directNodeIds = new Set<string>();
  const secondaryNodeIds = new Set<string>();
  const directEdgeIds = new Set<string>();
  const secondaryEdgeIds = new Set<string>();
  if (!selectedNodeId) return { directNodeIds, secondaryNodeIds, directEdgeIds, secondaryEdgeIds };
  directNodeIds.add(selectedNodeId);
  for (const edge of edges) {
    if (edge.source !== selectedNodeId && edge.target !== selectedNodeId) continue;
    directEdgeIds.add(edgeIdentity(edge));
    directNodeIds.add(edge.source);
    directNodeIds.add(edge.target);
  }
  for (const edge of edges) {
    const id = edgeIdentity(edge);
    if (directEdgeIds.has(id)) continue;
    if (!directNodeIds.has(edge.source) && !directNodeIds.has(edge.target)) continue;
    secondaryEdgeIds.add(id);
    secondaryNodeIds.add(edge.source);
    secondaryNodeIds.add(edge.target);
  }
  for (const id of directNodeIds) secondaryNodeIds.delete(id);
  return { directNodeIds, secondaryNodeIds, directEdgeIds, secondaryEdgeIds };
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
    { id: "change", label: "Code modified", kicker: "Change", event: change, status: change ? "changed" : "planned", subtitle: "Diff and changed nodes recorded" },
    { id: "verify", label: "Tests verify fix", kicker: "Verification", event: verification, status: verification?.status ?? (change ? "active" : "planned"), subtitle: "Post-change execution checked" },
    { id: "complete", label: "Completion allowed", kicker: "Outcome", event: completion, status: completion?.status ?? "planned", subtitle: "Proof contract satisfied" }
  ];
  return { nodes, edges: nodes.slice(1).map((node, index) => ({ source: nodes[index]!.id, target: node.id, kind: "causes", label: "then", active: Boolean(node.event) })) };
}

function modelGraph(graph: RepositoryGraph, events: readonly LedgerEvent[], selectedProjectId: string | null, delivery: DeliverySnapshot | null): DisplayGraph {
  const statuses = eventStatuses(graph, events);
  const architecture = graph.architecture;
  if (!architecture) return { nodes: [], edges: [] };
  if (!selectedProjectId) {
    const nodes = architecture.projects.map((project) => {
      const source = graph.nodes.find((node) => node.id === project.id)!;
      return {
        ...asDisplayNode({ ...source, data: { ...source.data, stats: project.stats } }, statuses),
        subtitle: `${project.frameworks.join(" + ") || project.kind} · ${project.stats.files} files · ${project.stats.routes} routes`
      };
    });
    const allowed = new Set(nodes.map((node) => node.id));
    return { nodes, edges: graph.edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)).map((edge) => displayEdge(edge, statuses)) };
  }

  const project = architecture.projects.find((candidate) => candidate.id === selectedProjectId);
  if (!project) return { nodes: [], edges: [] };
  const owned = graph.nodes.filter((node) => node.id !== project.id && node.data.projectId === project.id);
  const routeIds = new Set(architecture.routes.filter((route) => route.projectId === project.id).map((route) => route.id));
  const deliveryIds = new Set(delivery?.pathNodeIds ?? []);
  const activeIds = new Set([...statuses.keys(), ...deliveryIds]);
  const connected = new Set<string>([project.id, ...routeIds, ...project.entryNodeIds, ...activeIds]);
  for (const edge of graph.edges) {
    if (connected.has(edge.source) || connected.has(edge.target)) {
      connected.add(edge.source);
      connected.add(edge.target);
    }
  }
  const eligible = owned.filter((node) => connected.has(node.id));
  const details: GraphNode[] = [];
  const selectedIds = new Set<string>();
  const take = (items: GraphNode[], count: number): void => {
    for (const item of items) {
      if (details.length >= 64 || selectedIds.has(item.id)) continue;
      details.push(item);
      selectedIds.add(item.id);
      if (items.filter((candidate) => selectedIds.has(candidate.id)).length >= count) break;
    }
  };
  take(eligible.filter((node) => deliveryIds.has(node.id)), 24);
  take(eligible.filter((node) => activeIds.has(node.id)), 10);
  take(eligible.filter((node) => node.kind === "route"), 14);
  take(eligible.filter((node) => node.kind === "data"), 12);
  take(eligible.filter((node) => project.entryNodeIds.includes(node.id)), 8);
  take(eligible.filter((node) => node.kind === "file"), 8);
  take(eligible.filter((node) => node.kind === "function"), 14);
  take(eligible.filter((node) => node.kind === "test"), 6);
  const sourceNodes = [graph.nodes.find((node) => node.id === project.id)!, ...details];
  const allowed = new Set(sourceNodes.map((node) => node.id));
  return {
    nodes: sourceNodes.map((node) => asDisplayNode(node, statuses)),
    edges: graph.edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)).map((edge) => displayEdge(edge, statuses))
  };
}

function traceNodeIds(node: PositionedNode): string[] {
  const sourceId = typeof node.data?.sourceNodeId === "string" ? node.data.sourceNodeId : null;
  return [...new Set([node.id, ...(sourceId ? [sourceId] : []), ...(node.event?.nodeIds ?? [])])];
}

function routesGraph(graph: RepositoryGraph, events: readonly LedgerEvent[], selectedProjectId: string | null, selectedNodeId: string | null): DisplayGraph {
  const statuses = eventStatuses(graph, events);
  const selectedRoute = selectedNodeId ? graph.architecture?.routes.find((route) => route.id === selectedNodeId) : undefined;
  const routes = selectedRoute ? [selectedRoute] : (graph.architecture?.routes ?? []).filter((route) => !selectedProjectId || route.projectId === selectedProjectId).slice(0, 80);
  const ids = new Set(routes.map((route) => route.id));
  for (let depth = 0; depth < (selectedRoute ? 3 : 1); depth += 1) {
    for (const edge of graph.edges) {
      if (ids.has(edge.source) && ["handles", "requests", "calls", "uses-data"].includes(edge.kind)) ids.add(edge.target);
    }
  }
  const sourceNodes = graph.nodes.filter((node) => ids.has(node.id));
  return {
    nodes: sourceNodes.map((node) => asDisplayNode(node, statuses)),
    edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target) && ["handles", "requests", "calls", "uses-data"].includes(edge.kind)).map((edge) => displayEdge(edge, statuses))
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

function eventVerb(event: LedgerEvent): string {
  if (event.type === "agent.completed" && typeof event.data.agentType !== "string" && typeof event.data.description !== "string" && typeof event.data.taskId === "string") return "Task stopped";
  const labels: Record<string, string> = {
    "agent.spawned": "Agent spawned", "agent.completed": "Agent completed", "agent.failed": "Agent failed",
    "workflow.task.created": "Task created", "workflow.task.updated": "Task updated", "workflow.task.stopped": "Task stopped", "file.changed": "Code changed",
    "test.completed": "Tests completed", "node.inspected": "Code inspected", "task.started": "Task started",
    "agent.prompted": "Agent prompted", "tool.failed": "Command failed", "tool.completed": "Command ran",
    "skill.invoked": "Skill invoked", "skill.failed": "Skill failed"
  };
  return labels[event.type] ?? event.type.replaceAll(".", " ");
}

function eventLane(event: LedgerEvent): string {
  if (event.type.startsWith("workflow.task.")) return String(event.data.parentLaneId ?? event.data.laneId ?? "main");
  if (event.type === "agent.completed" && typeof event.data.agentType !== "string" && typeof event.data.description !== "string") return "main";
  return String(event.data.laneId ?? "main");
}

function scenarioGraph(graph: RepositoryGraph, events: readonly LedgerEvent[], selectedProjectId: string | null): DisplayGraph {
  const ignored = new Set(["usage.sampled", "agent.stopped", "hook.invoked", "tool.prepared"]);
  const candidates = events.filter((event) => !ignored.has(event.type)).flatMap((event): DisplayNode[] => {
    const projectId = eventProject(graph, event);
    if (selectedProjectId && projectId !== selectedProjectId) return [];
    const project = graph.architecture?.projects.find((item) => item.id === projectId);
    const laneId = eventLane(event);
    if (event.type === "node.executed") {
      const counts = new Map<string, number>();
      if (Array.isArray(event.data.executions)) for (const item of event.data.executions as Array<{ nodeId?: unknown; count?: unknown }>) {
        if (typeof item.nodeId === "string" && typeof item.count === "number") counts.set(item.nodeId, item.count);
      }
      return event.nodeIds.slice(0, 18).flatMap((id, offset): DisplayNode[] => {
        const source = graph.nodes.find((node) => node.id === id);
        if (!source) return [];
        const parameters = stringArray(source.data.parameters);
        return [{
          ...source,
          id: `scenario:${event.id}:${id}`,
          label: source.label,
          kicker: `${String(event.data.stage ?? "runtime")} · ×${counts.get(id) ?? 1}`,
          subtitle: parameters.length > 0 ? `(${parameters.join(", ")})` : `${source.file}:${source.line}`,
          status: "observed" as const,
          event,
          data: { ...source.data, laneId, parentLaneId: event.data.parentLaneId, order: event.seq + offset / 100, sourceNodeId: id }
        }];
      });
    }
    const detail = typeof event.data.description === "string" ? event.data.description
      : typeof event.data.subject === "string" ? event.data.subject
        : typeof event.data.command === "string" ? event.data.command
          : Array.isArray(event.data.files) ? event.data.files.map(String).join(", ") : event.status;
    return [{
      id: `scenario:${event.id}`,
      label: `${project?.name ?? "Repository"} · ${eventVerb(event)}`,
      kicker: `Step ${event.seq}`,
      subtitle: shorten(detail, 56),
      status: event.status,
      event,
      data: { projectId, laneId, parentLaneId: event.data.parentLaneId, order: event.seq }
    }];
  }).slice(-72);

  const laneLabels = new Map<string, string>();
  for (const node of candidates) {
    const lane = String(node.data?.laneId ?? "main");
    const description = typeof node.event?.data.description === "string" ? node.event.data.description : null;
    const agentType = typeof node.event?.data.agentType === "string" ? node.event.data.agentType : null;
    if (!laneLabels.has(lane)) laneLabels.set(lane, lane === "main" ? "Main agent" : description ?? agentType ?? `Agent ${lane.slice(0, 8)}`);
  }
  const edges: DisplayEdge[] = [];
  const lastByLane = new Map<string, DisplayNode>();
  for (const node of candidates) {
    const lane = String(node.data?.laneId ?? "main");
    const previous = lastByLane.get(lane);
    if (previous) edges.push({ source: previous.id, target: node.id, kind: "next", label: "next", active: true });
    else {
      const parentLane = typeof node.data?.parentLaneId === "string" ? node.data.parentLaneId : null;
      const parent = parentLane ? lastByLane.get(parentLane) ?? lastByLane.get("main") : null;
      if (parent) edges.push({ source: parent.id, target: node.id, kind: "spawns", label: "spawns", active: true });
    }
    lastByLane.set(lane, node);
  }
  return { nodes: candidates, edges, lanes: [...laneLabels].map(([id, label]) => ({ id, label })) };
}

export function layoutDisplayGraph(graph: DisplayGraph, mode: GraphMode, width: number): PositionedNode[] {
  if (mode === "scenario") {
    const lanes = graph.lanes ?? [{ id: "main", label: "Main agent" }];
    const laneIndex = new Map(lanes.map((lane, index) => [lane.id, index]));
    const order = [...graph.nodes].sort((left, right) => Number(left.data?.order ?? 0) - Number(right.data?.order ?? 0));
    return order.map((node, index) => ({ ...node, x: 190 + index * 245, y: 125 + (laneIndex.get(String(node.data?.laneId ?? "main")) ?? 0) * 165 }));
  }
  if (mode === "proof") return graph.nodes.map((node, index) => ({ ...node, x: 170 + index * 245, y: 210 }));
  if (mode === "model" && graph.nodes.length > 1 && graph.nodes.every((node) => node.kind === "project")) {
    const root = graph.nodes.find((node) => node.file === ".") ?? graph.nodes[0]!;
    const children = graph.nodes.filter((node) => node.id !== root.id);
    const columns = Math.min(3, Math.max(1, children.length));
    return [{ ...root, x: Math.max(460, width / 2), y: 115 }, ...children.map((node, index) => ({
      ...node, x: 230 + (index % columns) * 330, y: 300 + Math.floor(index / columns) * 170
    }))];
  }
  const order: NodeKind[] = ["project", "route", "file", "function", "data", "test"];
  const groups = order.map((kind) => graph.nodes.filter((node) => node.kind === kind)).filter((group) => group.length > 0);
  const positions: PositionedNode[] = [];
  const positionedX = new Map<string, number>();
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const connectedX = (id: string): number[] => graph.edges.flatMap((edge) => {
    if (edge.source === id && positionedX.has(edge.target)) return [positionedX.get(edge.target)!];
    if (edge.target === id && positionedX.has(edge.source)) return [positionedX.get(edge.source)!];
    return [];
  });
  let bandTop = 105;
  groups.forEach((unsortedGroup) => {
    const group = [...unsortedGroup].sort((left, right) => {
      const leftX = connectedX(left.id);
      const rightX = connectedX(right.id);
      const leftCenter = leftX.length > 0 ? leftX.reduce((sum, value) => sum + value, 0) / leftX.length : Number.POSITIVE_INFINITY;
      const rightCenter = rightX.length > 0 ? rightX.reduce((sum, value) => sum + value, 0) / rightX.length : Number.POSITIVE_INFINITY;
      if (leftCenter !== rightCenter) return leftCenter - rightCenter;
      const degreeDifference = (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0);
      return degreeDifference || left.label.localeCompare(right.label);
    });
    const columns = Math.min(5, Math.max(1, group.length));
    group.forEach((node, index) => {
      const x = 175 + (index % columns) * 295;
      positions.push({ ...node, x, y: bandTop + Math.floor(index / columns) * 140 });
      positionedX.set(node.id, x);
    });
    bandTop += Math.ceil(group.length / columns) * 140 + 110;
  });
  return positions;
}

export function countNodeCollisions(nodes: readonly PositionedNode[]): number {
  let collisions = 0;
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex]!;
      if (Math.abs(left.x - right.x) < NODE_WIDTH + 24 && Math.abs(left.y - right.y) < NODE_HEIGHT + 24) collisions += 1;
    }
  }
  return collisions;
}

function bounds(nodes: readonly PositionedNode[]): { left: number; top: number; right: number; bottom: number } {
  if (nodes.length === 0) return { left: 0, top: 0, right: 800, bottom: 600 };
  return {
    left: Math.min(...nodes.map((node) => node.x - NODE_WIDTH / 2)),
    top: Math.min(...nodes.map((node) => node.y - NODE_HEIGHT / 2)),
    right: Math.max(...nodes.map((node) => node.x + NODE_WIDTH / 2)),
    bottom: Math.max(...nodes.map((node) => node.y + NODE_HEIGHT / 2))
  };
}

function contextBubbles(selected: PositionedNode | undefined, graph: RepositoryGraph): ContextBubble[] {
  if (!selected) return [];
  const sourceId = typeof selected.data?.sourceNodeId === "string" ? selected.data.sourceNodeId : selected.id;
  const source = graph.nodes.find((node) => node.id === sourceId);
  const result: ContextBubble[] = [];
  if (source) {
    const parameters = stringArray(source.data.parameters);
    const fields = stringArray(source.data.fields);
    if (parameters.length > 0) result.push({ label: "Parameters", detail: parameters.join(", ") });
    if (typeof source.data.returns === "string") result.push({ label: "Returns", detail: source.data.returns });
    if (fields.length > 0) result.push({ label: "Data fields", detail: fields.slice(0, 4).join(" · ") });
  }
  const eventData = selected.event?.data;
  if (eventData) {
    if (typeof eventData.laneId === "string") result.push({ label: "Workflow lane", detail: eventData.laneId });
    if (typeof eventData.parentLaneId === "string") result.push({ label: "Spawned by", detail: eventData.parentLaneId });
    if (typeof eventData.agentType === "string") result.push({ label: "Agent type", detail: eventData.agentType });
    if (typeof eventData.model === "string") result.push({ label: "Model", detail: eventData.model });
    if (typeof eventData.totalTokens === "number") result.push({ label: "Agent tokens", detail: eventData.totalTokens.toLocaleString() });
    if (typeof eventData.totalToolUseCount === "number") result.push({ label: "Tool actions", detail: String(eventData.totalToolUseCount) });
  }
  const diff = typeof selected.event?.data.diff === "string" ? selected.event.data.diff : null;
  if (diff) {
    const additions = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const removals = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    result.push({ label: "Recorded change", detail: `+${additions} −${removals} lines` });
  }
  return result.slice(0, 7);
}

function rectanglesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
  padding = 14
): boolean {
  return Math.abs(left.x - right.x) < (left.width + right.width) / 2 + padding
    && Math.abs(left.y - right.y) < (left.height + right.height) / 2 + padding;
}

function positionContextBubbles(selected: PositionedNode | undefined, nodes: readonly PositionedNode[], bubbles: readonly ContextBubble[]): PositionedBubble[] {
  if (!selected || bubbles.length === 0) return [];
  const candidates: Array<{ x: number; y: number }> = [];
  for (const radius of [1, 1.65, 2.3]) {
    for (const [x, y] of [[-250, -125], [250, -125], [-270, 0], [270, 0], [-250, 125], [250, 125], [0, -175], [0, 175]] as const) {
      candidates.push({ x: selected.x + x * radius, y: selected.y + y * radius });
    }
  }
  const occupied = nodes.map((node) => ({ x: node.x, y: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }));
  const result: PositionedBubble[] = [];
  for (const bubble of bubbles) {
    const candidate = candidates.find((position) => {
      const rectangle = { ...position, width: BUBBLE_WIDTH, height: BUBBLE_HEIGHT };
      return !occupied.some((item) => rectanglesOverlap(rectangle, item))
        && !result.some((item) => rectanglesOverlap(rectangle, { x: item.x, y: item.y, width: BUBBLE_WIDTH, height: BUBBLE_HEIGHT }, 8));
    });
    if (!candidate) break;
    result.push({ ...bubble, ...candidate });
    candidates.splice(candidates.indexOf(candidate), 1);
  }
  return result;
}

export interface RoutedEdge {
  path: string;
  labelX: number;
  labelY: number;
}

export function routeDisplayEdge(source: PositionedNode, target: PositionedNode, index: number): RoutedEdge {
  const horizontalDistance = target.x - source.x;
  const verticalDistance = target.y - source.y;
  const portOffset = ((index % 5) - 2) * 7;
  if (Math.abs(verticalDistance) > Math.max(90, Math.abs(horizontalDistance) * 0.52)) {
    const direction = Math.sign(verticalDistance) || 1;
    const sourceY = source.y + direction * NODE_HEIGHT / 2;
    const targetY = target.y - direction * NODE_HEIGHT / 2;
    const middleY = (sourceY + targetY) / 2;
    return {
      path: `M ${source.x + portOffset} ${sourceY} C ${source.x + portOffset} ${middleY}, ${target.x + portOffset} ${middleY}, ${target.x + portOffset} ${targetY}`,
      labelX: (source.x + target.x) / 2 + portOffset,
      labelY: middleY - 7
    };
  }
  const direction = Math.sign(horizontalDistance) || 1;
  const sourceX = source.x + direction * NODE_WIDTH / 2;
  const targetX = target.x - direction * NODE_WIDTH / 2;
  const middleX = (sourceX + targetX) / 2;
  return {
    path: `M ${sourceX} ${source.y + portOffset} C ${middleX} ${source.y + portOffset}, ${middleX} ${target.y + portOffset}, ${targetX} ${target.y + portOffset}`,
    labelX: middleX,
    labelY: (source.y + target.y) / 2 - 7 + portOffset
  };
}

function activateWithKeyboard(event: KeyboardEvent<SVGGElement>, action: () => void): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    action();
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function GraphCanvas({ mode, graph, events, selectedNodeId, selectedProjectId, onSelectNode, onOpenNode, onClearSelection, delivery, traceView }: GraphCanvasProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ center: { x: number; y: number }; distance: number } | null>(null);
  const [size, setSize] = useState({ width: 1000, height: 720 });
  const [view, setView] = useState<ViewTransform>({ x: 30, y: 30, scale: 1 });
  const [panning, setPanning] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ width: Math.max(520, Math.round(entry.contentRect.width)), height: Math.max(560, Math.round(entry.contentRect.height)) });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const displayGraph = useMemo(() => mode === "proof" ? proofGraph(events) : mode === "model" ? modelGraph(graph, events, selectedProjectId, delivery) : mode === "routes" ? routesGraph(graph, events, selectedProjectId, selectedNodeId) : scenarioGraph(graph, events, selectedProjectId), [delivery, events, graph, mode, selectedNodeId, selectedProjectId]);
  const nodes = useMemo(() => layoutDisplayGraph(displayGraph, mode, size.width), [displayGraph, mode, size.width]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selected = selectedNodeId ? byId.get(selectedNodeId) : undefined;
  const focus = useMemo(() => connectedNeighborhood(displayGraph.edges, selected?.id ?? null), [displayGraph.edges, selected?.id]);
  const bubbles = useMemo(() => contextBubbles(selected, graph), [graph, selected]);
  const positionedBubbles = useMemo(() => positionContextBubbles(selected, nodes, bubbles), [bubbles, nodes, selected]);
  const contentBounds = useMemo(() => bounds(nodes), [nodes]);

  const fit = useCallback(() => {
    const contentWidth = Math.max(1, contentBounds.right - contentBounds.left);
    const contentHeight = Math.max(1, contentBounds.bottom - contentBounds.top);
    const scale = clamp(Math.min((size.width - 120) / contentWidth, (size.height - 120) / contentHeight), MIN_SCALE, 1.25);
    setView({
      scale,
      x: (size.width - contentWidth * scale) / 2 - contentBounds.left * scale,
      y: (size.height - contentHeight * scale) / 2 - contentBounds.top * scale
    });
  }, [contentBounds, size]);

  useEffect(() => {
    if (nodes.length === 0) return;
    if (mode === "scenario") {
      setView({ x: Math.min(40, size.width - contentBounds.right - 80), y: 30, scale: 1 });
      return;
    }
    fit();
  }, [mode, nodes.length, selectedProjectId, size.height, size.width]);

  useEffect(() => {
    if (!selectedNodeId || !selected || selected.kind === "project") return;
    const related = nodes.filter((node) => focus.directNodeIds.has(node.id));
    if (related.length === 0) return;
    const relatedBounds = bounds(related);
    const focusWidth = Math.max(1, relatedBounds.right - relatedBounds.left);
    const focusHeight = Math.max(1, relatedBounds.bottom - relatedBounds.top);
    const scale = clamp(Math.min((size.width - 240) / focusWidth, (size.height - 220) / focusHeight), 0.55, 1.25);
    setView({
      scale,
      x: (size.width - focusWidth * scale) / 2 - relatedBounds.left * scale,
      y: (size.height - focusHeight * scale) / 2 - relatedBounds.top * scale
    });
  }, [focus.directNodeIds, nodes, selected, selectedNodeId, size.height, size.width]);

  const zoomAt = useCallback((nextScale: number, screenX = size.width / 2, screenY = size.height / 2) => {
    setView((current) => {
      const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
      const contentX = (screenX - current.x) / current.scale;
      const contentY = (screenY - current.y) / current.scale;
      return { scale, x: screenX - contentX * scale, y: screenY - contentY * scale };
    });
  }, [size]);

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>): void => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const factor = Math.exp(-event.deltaY * 0.0015);
    zoomAt(view.scale * factor, event.clientX - rect.left, event.clientY - rect.top);
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    setPanning(true);
    gesture.current = null;
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (!pointers.current.has(event.pointerId)) return;
    const previous = pointers.current.get(event.pointerId)!;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];
    if (points.length === 1) {
      setView((current) => ({ ...current, x: current.x + event.clientX - previous.x, y: current.y + event.clientY - previous.y }));
      return;
    }
    const [first, second] = points;
    if (!first || !second) return;
    const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    const distance = Math.hypot(first.x - second.x, first.y - second.y);
    if (gesture.current) {
      const scaleFactor = distance / Math.max(1, gesture.current.distance);
      setView((current) => {
        const nextScale = clamp(current.scale * scaleFactor, MIN_SCALE, MAX_SCALE);
        const contentX = (gesture.current!.center.x - current.x) / current.scale;
        const contentY = (gesture.current!.center.y - current.y) / current.scale;
        return { scale: nextScale, x: center.x - contentX * nextScale, y: center.y - contentY * nextScale };
      });
    }
    gesture.current = { center, distance };
  };

  const onPointerEnd = (event: ReactPointerEvent<SVGSVGElement>): void => {
    pointers.current.delete(event.pointerId);
    gesture.current = null;
    if (pointers.current.size === 0) setPanning(false);
  };

  const lanePositions = new Map((displayGraph.lanes ?? []).map((lane, index) => [lane.id, 125 + index * 165]));
  const hasFocus = Boolean(selected);
  const deliveryFocus = traceView === "delivery" && Boolean(delivery) && !hasFocus;
  const deliveredIds = new Set(delivery?.deliveredNodeIds ?? []);
  const verifiedIds = new Set(delivery?.verifiedNodeIds ?? []);
  const referenceIds = new Set(delivery?.referenceNodeIds ?? []);
  const unrelatedIds = new Set(delivery?.unrelatedTouchedNodeIds ?? []);
  const deliveryEventIds = new Set(delivery?.pathEventIds ?? []);
  const deliveryEdgeIds = new Set(delivery?.pathEdgeIds ?? []);
  const directlyConnectedCount = Math.max(0, focus.directNodeIds.size - 1);

  return (
    <div className={`graph-canvas ${panning ? "is-panning" : ""} ${hasFocus ? "has-focus" : ""} ${deliveryFocus ? "has-delivery-focus" : ""}`} ref={containerRef}>
      <div className="zoom-controls" aria-label="Graph zoom controls">
        <button type="button" onClick={() => zoomAt(view.scale + 0.2)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => zoomAt(view.scale - 0.2)} aria-label="Zoom out">−</button>
        <button type="button" onClick={fit}>Fit</button>
        <span>{Math.round(view.scale * 100)}%</span>
      </div>
      {hasFocus ? <div className="graph-focus-summary"><span>{directlyConnectedCount} connected</span><button type="button" onClick={onClearSelection}>Clear focus</button></div> : null}
      <div className="canvas-help">Drag to pan · wheel or pinch to zoom · select to trace relationships</div>
      <svg viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-labelledby="graph-heading graph-description" onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
        <desc id="graph-description">Interactive repository architecture and workflow trace. Drag to pan and use the wheel or pinch gesture to zoom.</desc>
        <defs>
          <marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="graph-arrow" /></marker>
          <marker id="graph-arrow-focus" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="graph-arrow graph-arrow--focus" /></marker>
          <marker id="graph-arrow-delivery" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="graph-arrow graph-arrow--delivery" /></marker>
        </defs>
        <rect className="graph-hitarea" width={size.width} height={size.height} onDoubleClick={onClearSelection} />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {(displayGraph.lanes ?? []).map((lane) => {
            const y = lanePositions.get(lane.id) ?? 0;
            return <g key={lane.id} className="workflow-lane"><line x1="50" y1={y} x2={Math.max(contentBounds.right + 150, 1000)} y2={y} /><text x="58" y={y - 58}>{shorten(lane.label, 28)}</text></g>;
          })}
          {displayGraph.edges.map((edge, index) => {
            const source = byId.get(edge.source);
            const target = byId.get(edge.target);
            if (!source || !target) return null;
            const routed = routeDisplayEdge(source, target, index);
            const id = edgeIdentity(edge);
            const direct = focus.directEdgeIds.has(id);
            const secondary = focus.secondaryEdgeIds.has(id);
            const sourceDelivery = deliveryEventIds.has(source.event?.id ?? "") || traceNodeIds(source).some((nodeId) => deliveredIds.has(nodeId) || verifiedIds.has(nodeId) || referenceIds.has(nodeId));
            const targetDelivery = deliveryEventIds.has(target.event?.id ?? "") || traceNodeIds(target).some((nodeId) => deliveredIds.has(nodeId) || verifiedIds.has(nodeId) || referenceIds.has(nodeId));
            const deliveryPath = deliveryFocus && (deliveryEdgeIds.has(edge.id ?? "") || (sourceDelivery && targetDelivery));
            const focusClass = direct ? "is-focused" : secondary ? "is-secondary" : hasFocus ? "is-muted" : deliveryPath ? "is-delivery" : deliveryFocus ? "is-muted" : "";
            return <g key={`${edge.source}:${edge.target}:${index}`} className={`graph-edge-group graph-edge-group--${edge.kind} ${focusClass}`}><path d={routed.path} className={`graph-edge ${edge.active ? "is-active" : ""}`} markerEnd={direct ? "url(#graph-arrow-focus)" : deliveryPath ? "url(#graph-arrow-delivery)" : "url(#graph-arrow)"} /><text x={routed.labelX} y={routed.labelY}>{shorten(edge.label, 24)}</text></g>;
          })}
          {nodes.map((node) => {
            const nodeIds = traceNodeIds(node);
            const eventDelivered = deliveryEventIds.has(node.event?.id ?? "");
            const deliveryClass = nodeIds.some((id) => verifiedIds.has(id)) ? "is-verified-delivery"
              : nodeIds.some((id) => deliveredIds.has(id)) || eventDelivered ? "is-delivered"
                : nodeIds.some((id) => referenceIds.has(id)) ? "is-delivery-reference"
                  : nodeIds.some((id) => unrelatedIds.has(id)) ? "is-unrelated-touch" : "is-muted";
            const focusClass = selectedNodeId === node.id ? "is-selected" : focus.directNodeIds.has(node.id) ? "is-related" : focus.secondaryNodeIds.has(node.id) ? "is-secondary" : hasFocus ? "is-muted" : deliveryFocus ? deliveryClass : "";
            return <g key={node.id} transform={`translate(${node.x - NODE_WIDTH / 2} ${node.y - NODE_HEIGHT / 2})`} className={`graph-node graph-node--${node.status} graph-node--kind-${node.kind ?? "evidence"} ${focusClass}`} role="button" tabIndex={0} aria-label={`${node.label}, ${node.status}`} onPointerDown={(event) => event.stopPropagation()} onClick={() => onSelectNode(node)} onDoubleClick={() => onOpenNode(node)} onKeyDown={(event) => activateWithKeyboard(event, () => onSelectNode(node))}>
              <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx="14" />
              <circle className="graph-node__status" cx="18" cy="20" r="5" />
              <text className="graph-node__kicker" x="31" y="23">{shorten(node.kicker.toUpperCase(), 28)}</text>
              <text className="graph-node__label" x="14" y="49">{shorten(node.label, 31)}</text>
              {node.subtitle ? <text className="graph-node__subtitle" x="14" y="69">{shorten(node.subtitle, 38)}</text> : null}
            </g>;
          })}
          {positionedBubbles.map((bubble, index) => selected ? <g key={`${bubble.label}:${index}`} className="context-bubble"><line x1={selected.x} y1={selected.y} x2={bubble.x} y2={bubble.y} /><rect x={bubble.x - BUBBLE_WIDTH / 2} y={bubble.y - BUBBLE_HEIGHT / 2} width={BUBBLE_WIDTH} height={BUBBLE_HEIGHT} rx="12" /><text className="context-bubble__label" x={bubble.x - BUBBLE_WIDTH / 2 + 10} y={bubble.y - 4}>{shorten(bubble.label.toUpperCase(), 23)}</text><text className="context-bubble__detail" x={bubble.x - BUBBLE_WIDTH / 2 + 10} y={bubble.y + 12}>{shorten(bubble.detail, 30)}</text></g> : null)}
        </g>
      </svg>
      {displayGraph.nodes.length === 0 ? <EmptyState title="No map available" description="Scan the repository to build its project, route, file, function, and data model graph." /> : null}
    </div>
  );
}
