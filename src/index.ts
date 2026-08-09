export { collectExecutedNodes, runTests } from "./core/coverage.js";
export { evaluateProof, finishRun } from "./core/proof.js";
export { scanProject } from "./core/scanner.js";
export {
  appendEvent,
  createRun,
  ensureState,
  getRun,
  readConfig,
  readEvents,
  readGraph,
  readRuns,
  resetState,
  updateRun,
  writeGraph
} from "./core/store.js";
export { attachClaude, detachClaude, installClaudeHooks } from "./integrations/claude.js";
export { createDashboardServer } from "./server.js";
export type {
  AppendEventInput,
  ArchitectureModel,
  ConfidenceLevel,
  EventStatus,
  GraphEdge,
  GraphNode,
  LedgerEvent,
  LedgerEventData,
  NodeKind,
  ProjectKind,
  ProjectRelationship,
  ProjectSummary,
  ProofCheck,
  ProofPolicy,
  ProofReplayConfig,
  ProofResult,
  ProofRun,
  RepositoryGraph,
  RouteDefinition,
  RouteKind,
  StatePaths,
  TokenMonitoringConfig,
  TokenUsage
} from "./types.js";
