export type NodeKind = "project" | "route" | "file" | "function" | "data" | "test";

export type ConfidenceLevel = "high" | "medium" | "low";

export type ProjectKind = "application" | "package" | "repository" | "service" | "test";

export type RouteKind = "client" | "http" | "middleware" | "page";

export type EventStatus =
  | "active"
  | "blocked"
  | "changed"
  | "completed"
  | "failed"
  | "observed"
  | "passed"
  | "planned"
  | "running";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  file: string;
  line: number;
  start: number;
  end: number;
  data: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "calls" | "contains" | "depends-on" | "handles" | "imports" | "requests" | "uses-data";
  data: Record<string, unknown>;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  kind: ProjectKind;
  packageName: string | null;
  packageManager: "npm" | "pnpm" | "yarn" | null;
  frameworks: string[];
  entryNodeIds: string[];
  stats: {
    files: number;
    functions: number;
    tests: number;
    routes: number;
    dataModels: number;
  };
}

export interface RouteDefinition {
  id: string;
  projectId: string;
  kind: RouteKind;
  method: string;
  path: string;
  file: string;
  line: number;
  handlerNames: string[];
  handlerNodeIds: string[];
  confidence: ConfidenceLevel;
  evidence: string;
}

export interface ProjectRelationship {
  id: string;
  sourceProjectId: string;
  targetProjectId: string;
  kind: "imports";
  count: number;
  confidence: ConfidenceLevel;
}

export interface ArchitectureModel {
  projects: ProjectSummary[];
  routes: RouteDefinition[];
  relationships: ProjectRelationship[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
  observedAt: string;
  source: "claude-transcript" | "tool-response";
}

export interface TokenMonitoringConfig {
  sessionWarningTokens: number;
  turnSpikeTokens: number;
}

export interface RepositoryGraph {
  schemaVersion: 1;
  generatedAt: string;
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  architecture?: ArchitectureModel;
  stats: {
    files: number;
    functions: number;
    tests: number;
    edges: number;
    projects?: number;
    routes?: number;
    dataModels?: number;
  };
}

export interface ProofPolicy {
  requireReproduction: boolean;
  requireChange: boolean;
  requirePassingVerification: boolean;
  requireExecutedChangedNode: boolean;
}

export interface ProofReplayConfig {
  schemaVersion: 1;
  sourceExtensions: string[];
  exclude: string[];
  proofPolicy: ProofPolicy;
  tokenMonitoring: TokenMonitoringConfig;
}

export interface LedgerEventData {
  [key: string]: unknown;
}

export interface LedgerEvent {
  schemaVersion: 1;
  id: string;
  seq: number;
  timestamp: string;
  runId: string;
  type: string;
  status: EventStatus;
  nodeIds: string[];
  data: LedgerEventData;
}

export interface AppendEventInput {
  runId: string;
  type: string;
  status?: EventStatus;
  nodeIds?: string[];
  data?: LedgerEventData;
}

export interface ProofCheck {
  id: string;
  label: string;
  required: boolean;
  passed: boolean;
  evidenceEventId: string | null;
}

export interface ProofResult {
  runId: string;
  passed: boolean;
  checks: ProofCheck[];
  eventCount: number;
  evaluatedAt: string;
}

export interface ProofRun {
  id: string;
  prompt: string;
  status: "blocked" | "completed" | "detached" | "running";
  createdAt: string;
  completedAt: string | null;
  proof?: ProofResult;
}

export interface StatePaths {
  directory: string;
  config: string;
  graph: string;
  events: string;
  runs: string;
  claudeActive: string;
  coverage: string;
}
