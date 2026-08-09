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

export interface WorkflowContract {
  id: string;
  name: string;
  promptIncludes: string[];
  requiredSkills: string[];
  requiredHooks: string[];
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
  workflowContracts: WorkflowContract[];
}

export interface LedgerEventData {
  [key: string]: unknown;
}

export interface LedgerEvent {
  schemaVersion: 1 | 2;
  id: string;
  seq: number;
  timestamp: string;
  runId: string;
  sessionId: string | null;
  cycleId: string | null;
  promptId: string | null;
  workflowRunId: string | null;
  agentRunId: string | null;
  parentEventId: string | null;
  type: string;
  status: EventStatus;
  nodeIds: string[];
  data: LedgerEventData;
}

export interface AppendEventInput {
  runId: string;
  sessionId?: string;
  cycleId?: string;
  promptId?: string;
  workflowRunId?: string;
  agentRunId?: string;
  parentEventId?: string;
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
  sessionId: string;
  cycleId: string;
  prompt: string;
  status: "blocked" | "completed" | "detached" | "running" | "stopped";
  createdAt: string;
  completedAt: string | null;
  proof?: ProofResult;
}

export type SessionStatus = "active" | "completed" | "detached" | "abandoned";
export type PromptCycleStatus = "active" | "stopped" | "completed" | "blocked" | "detached";
export type LifecycleStatus = "planned" | "active" | "completed" | "failed" | "missed";
export type NodeDeliveryRole =
  | "touched"
  | "executed"
  | "changed"
  | "reverted"
  | "delivered"
  | "verified"
  | "delivery-reference"
  | "unrelated-touch";
export type EvidenceConfidence = "observed" | "derived" | "inferred";
export type TokenAttributionKind = "observed" | "allocated" | "inferred" | "unallocated";

export interface RepositorySnapshot {
  capturedAt: string;
  head: string | null;
  workingTreeHash: string;
  dirtyFiles: string[];
}

export interface PromptLifecycle {
  id: string;
  parentPromptId: string | null;
  agentRunId: string | null;
  workflowRunId: string | null;
  kind: "user" | "agent" | "workflow";
  text: string;
  startedAt: string;
  stoppedAt: string | null;
  status: LifecycleStatus;
  deliveredNodeIds: string[];
}

export interface AgentRunRecord {
  id: string;
  externalAgentId: string | null;
  parentAgentRunId: string | null;
  parentPromptId: string | null;
  workflowRunId: string | null;
  agentType: string | null;
  model: string | null;
  description: string | null;
  startedAt: string;
  stoppedAt: string | null;
  status: LifecycleStatus;
  tokenUsage: number;
}

export interface WorkflowRunRecord {
  id: string;
  externalTaskId: string | null;
  contractId: string | null;
  parentWorkflowRunId: string | null;
  parentAgentRunId: string | null;
  parentPromptId: string | null;
  name: string;
  startedAt: string;
  stoppedAt: string | null;
  status: LifecycleStatus;
  expectedSkills: string[];
  expectedHooks: string[];
  invokedSkills: string[];
  observedHooks: string[];
}

export interface SkillInvocationRecord {
  id: string;
  skill: string;
  agentRunId: string | null;
  workflowRunId: string | null;
  promptId: string | null;
  invokedAt: string;
  status: "completed" | "failed" | "observed";
  evidenceEventId: string;
}

export interface HookInvocationRecord {
  id: string;
  hook: string;
  agentRunId: string | null;
  invokedAt: string;
  status: "completed" | "failed" | "observed";
  evidenceEventId: string;
}

export interface NodeInteraction {
  id: string;
  nodeId: string;
  eventId: string;
  promptId: string | null;
  workflowRunId: string | null;
  agentRunId: string | null;
  operation: "read" | "search" | "execute" | "edit" | "create" | "delete" | "reference";
  role: NodeDeliveryRole;
  confidence: EvidenceConfidence;
  reason: string;
  observedAt: string;
  tokens: number;
  tokenAttribution: TokenAttributionKind;
}

export interface WorkflowCompliance {
  expectedSkills: string[];
  invokedSkills: string[];
  missingSkills: string[];
  expectedHooks: string[];
  observedHooks: string[];
  missingHooks: string[];
}

export interface DeliverySnapshot {
  capturedAt: string;
  baseline: RepositorySnapshot;
  finalState: RepositorySnapshot;
  diff: string;
  touchedNodeIds: string[];
  changedNodeIds: string[];
  deliveredNodeIds: string[];
  verifiedNodeIds: string[];
  referenceNodeIds: string[];
  revertedNodeIds: string[];
  unrelatedTouchedNodeIds: string[];
  pathNodeIds: string[];
  pathEdgeIds: string[];
  pathEventIds: string[];
  tokenUsage: number;
  allocatedTokens: number;
  unallocatedTokens: number;
  compliance: WorkflowCompliance;
}

export interface PromptCycleRecord {
  id: string;
  runId: string;
  ordinal: number;
  parentCycleId: string | null;
  prompt: string;
  startedAt: string;
  stoppedAt: string | null;
  status: PromptCycleStatus;
  baseline: RepositorySnapshot;
  prompts: PromptLifecycle[];
  workflows: WorkflowRunRecord[];
  agents: AgentRunRecord[];
  skills: SkillInvocationRecord[];
  hooks: HookInvocationRecord[];
  interactions: NodeInteraction[];
  delivery: DeliverySnapshot | null;
}

export interface SessionRecord {
  schemaVersion: 1;
  id: string;
  provider: "claude" | "codex" | "manual" | "unknown";
  externalSessionId: string | null;
  repositoryRoot: string;
  startedAt: string;
  endedAt: string | null;
  status: SessionStatus;
  cycles: PromptCycleRecord[];
}

export interface StatePaths {
  directory: string;
  config: string;
  graph: string;
  events: string;
  runs: string;
  sessions: string;
  claudeActive: string;
  coverage: string;
  baselines: string;
}
