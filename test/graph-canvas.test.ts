import assert from "node:assert/strict";
import test from "node:test";
import {
  connectedExecutionPath,
  connectedNeighborhood,
  countNodeCollisions,
  followNodeIntoView,
  lifecycleEvidence,
  layoutDisplayGraph,
  routeDisplayEdge,
  scenarioGraph,
  type DisplayEdge,
  type DisplayGraph,
  type DisplayNode
} from "../src/ui/components/GraphCanvas.js";
import type { LedgerEvent, PromptCycleRecord, RepositoryGraph } from "../src/types.js";

function node(id: string, kind: NonNullable<DisplayNode["kind"]>): DisplayNode {
  return { id, kind, label: id, kicker: kind, status: "planned" };
}

test("an unfocused live canvas follows appended nodes without resetting zoom", () => {
  const current = { x: -180, y: 40, scale: 1.65 };
  const size = { width: 1200, height: 760 };
  const followed = followNodeIntoView(current, { x: 1200, y: 260 }, size);

  assert.equal(followed.scale, current.scale);
  assert.notEqual(followed.x, current.x);
  assert.equal(followed.y, current.y);

  const alreadyVisible = followNodeIntoView(current, { x: 300, y: 260 }, size);
  assert.equal(alreadyVisible, current);
});

test("selection focuses direct and second-hop relationships without unrelated nodes", () => {
  const edges: DisplayEdge[] = [
    { source: "route", target: "handler", kind: "handles", label: "handles" },
    { source: "handler", target: "model", kind: "uses-data", label: "uses data" },
    { source: "other", target: "isolated", kind: "calls", label: "calls" }
  ];
  const focus = connectedNeighborhood(edges, "route");

  assert.deepEqual([...focus.directNodeIds].sort(), ["handler", "route"]);
  assert.deepEqual([...focus.secondaryNodeIds], ["model"]);
  assert.equal(focus.directEdgeIds.size, 1);
  assert.equal(focus.secondaryEdgeIds.size, 1);
  assert.equal(focus.directNodeIds.has("other"), false);
});

test("scenario selection retains the complete directed path as new nodes are appended", () => {
  const original: DisplayEdge[] = [
    { source: "cycle", target: "prompt", kind: "prompts", label: "starts" },
    { source: "prompt", target: "agent", kind: "runs", label: "agent" },
    { source: "agent", target: "step-1", kind: "acts", label: "acts" },
    { source: "agent", target: "sibling", kind: "delegates", label: "delegates" },
    { source: "unrelated", target: "isolated", kind: "calls", label: "calls" }
  ];
  const appended = [
    ...original,
    { source: "step-1", target: "step-2", kind: "next", label: "next" },
    { source: "step-2", target: "delivered", kind: "delivers", label: "delivers" }
  ];

  const focus = connectedExecutionPath(appended, "step-1");

  assert.deepEqual([...focus.directNodeIds].sort(), ["agent", "cycle", "delivered", "prompt", "step-1", "step-2"]);
  assert.equal(focus.directEdgeIds.size, 5);
  assert.equal(focus.directNodeIds.has("sibling"), false);
  assert.equal(focus.directNodeIds.has("unrelated"), false);
});

test("a nested agent owns the live event lane created by its spawn event", () => {
  const repository: RepositoryGraph = {
    schemaVersion: 1, generatedAt: "now", root: "/repo", nodes: [], edges: [],
    stats: { files: 0, functions: 0, tests: 0, edges: 0, projects: 0, routes: 0 }
  };
  const cycle: PromptCycleRecord = {
    id: "cycle", runId: "run", ordinal: 1, parentCycleId: null, prompt: "Implement fix", startedAt: "start", stoppedAt: null, status: "active",
    baseline: { capturedAt: "start", head: null, workingTreeHash: "a", dirtyFiles: [] },
    prompts: [{ id: "prompt", parentPromptId: null, agentRunId: "main", workflowRunId: null, kind: "user", text: "Implement fix", startedAt: "start", stoppedAt: null, status: "active", deliveredNodeIds: [] }],
    workflows: [],
    agents: [
      { id: "main", externalAgentId: "main-lane", parentAgentRunId: null, parentPromptId: "prompt", workflowRunId: null, agentType: "main", model: null, description: "Main", startedAt: "start", stoppedAt: null, status: "active", tokenUsage: 0 },
      { id: "child", externalAgentId: "child-lane", parentAgentRunId: "main", parentPromptId: "prompt", workflowRunId: null, agentType: "worker", model: null, description: "Worker", startedAt: "start", stoppedAt: null, status: "active", tokenUsage: 0 }
    ],
    skills: [], hooks: [], interactions: [], delivery: null
  };
  const event = (id: string, seq: number, type: string, agentRunId: string): LedgerEvent => ({
    schemaVersion: 2, id, seq, timestamp: "now", runId: "run", sessionId: "session", cycleId: "cycle", promptId: "prompt", workflowRunId: null,
    agentRunId, parentEventId: null, type, status: "passed", nodeIds: [], data: { laneId: "child-lane" }
  });

  const display = scenarioGraph(repository, [event("spawn", 1, "agent.spawned", "main"), event("work", 2, "tool.completed", "child")], null, cycle, "exploration");
  const childId = "lifecycle:agent:child";
  assert.ok(display.edges.some((edge) => edge.source === childId && edge.target === "scenario:spawn"));
  assert.ok(display.edges.some((edge) => edge.source === "scenario:spawn" && edge.target === "scenario:work"));
  const focus = connectedExecutionPath(display.edges, childId);
  assert.ok(focus.directNodeIds.has("scenario:spawn"));
  assert.ok(focus.directNodeIds.has("scenario:work"));
});

test("dense architecture bands remain collision free", () => {
  const nodes = [
    node("project", "project"),
    ...Array.from({ length: 24 }, (_, index) => node(`route-${index}`, "route")),
    ...Array.from({ length: 24 }, (_, index) => node(`function-${index}`, "function")),
    ...Array.from({ length: 10 }, (_, index) => node(`model-${index}`, "data"))
  ];
  const edges: DisplayEdge[] = Array.from({ length: 24 }, (_, index) => ({
    source: `route-${index}`,
    target: `function-${index}`,
    kind: "handles",
    label: "handles"
  }));
  const graph: DisplayGraph = { nodes, edges };
  const positioned = layoutDisplayGraph(graph, "model", 1440);

  assert.equal(countNodeCollisions(positioned), 0);
  const route = positioned.find((item) => item.id === "route-0")!;
  const handler = positioned.find((item) => item.id === "function-0")!;
  const routed = routeDisplayEdge(route, handler, 0);
  assert.match(routed.path, /^M /);
  assert.ok(Number.isFinite(routed.labelX));
  assert.ok(Number.isFinite(routed.labelY));
});

test("stopped cycles become connected lifecycle-to-delivery graphs with mapped tokens", () => {
  const repository: RepositoryGraph = {
    schemaVersion: 1, generatedAt: "now", root: "/repo",
    nodes: [
      { id: "project", kind: "project", label: "app", file: ".", line: 1, start: 0, end: 0, data: { projectId: "project" } },
      { id: "function", kind: "function", label: "deliverFix", file: "src/fix.ts", line: 4, start: 0, end: 40, data: { projectId: "project", parameters: ["input"] } },
      { id: "test", kind: "test", label: "fix is verified", file: "test/fix.test.ts", line: 3, start: 0, end: 20, data: { projectId: "project" } }
    ],
    edges: [{ id: "edge-test", source: "test", target: "function", kind: "calls", data: { arguments: ["input"] } }],
    stats: { files: 2, functions: 1, tests: 1, edges: 1, projects: 1, routes: 0 },
    architecture: { projects: [{ id: "project", name: "app", path: ".", kind: "application", packageName: "app", packageManager: "npm", frameworks: [], entryNodeIds: ["function"], stats: { files: 2, functions: 1, tests: 1, routes: 0, dataModels: 0 } }], routes: [], relationships: [] }
  };
  const cycle: PromptCycleRecord = {
    id: "cycle-1", runId: "run-1", ordinal: 1, parentCycleId: null, prompt: "Fix the bug", startedAt: "2026-01-01T00:00:00Z", stoppedAt: "2026-01-01T00:10:00Z", status: "stopped",
    baseline: { capturedAt: "start", head: null, workingTreeHash: "a", dirtyFiles: [] },
    prompts: [
      { id: "prompt-root", parentPromptId: null, agentRunId: "agent-main", workflowRunId: null, kind: "user", text: "Fix the bug", startedAt: "start", stoppedAt: "stop", status: "completed", deliveredNodeIds: ["function"] },
      { id: "prompt-agent", parentPromptId: "prompt-root", agentRunId: "agent-child", workflowRunId: null, kind: "agent", text: "Verify the fix", startedAt: "start", stoppedAt: "stop", status: "completed", deliveredNodeIds: ["function"] }
    ],
    workflows: [],
    agents: [
      { id: "agent-main", externalAgentId: "main", parentAgentRunId: null, parentPromptId: "prompt-root", workflowRunId: null, agentType: "main", model: "sonnet", description: "Main agent", startedAt: "start", stoppedAt: "stop", status: "completed", tokenUsage: 800 },
      { id: "agent-child", externalAgentId: "child", parentAgentRunId: "agent-main", parentPromptId: "prompt-agent", workflowRunId: null, agentType: "test", model: "haiku", description: "Test agent", startedAt: "start", stoppedAt: "stop", status: "completed", tokenUsage: 500 }
    ],
    skills: [], hooks: [],
    interactions: [
      { id: "i1", nodeId: "function", eventId: "e1", promptId: "prompt-agent", workflowRunId: null, agentRunId: "agent-child", operation: "edit", role: "delivered", confidence: "observed", reason: "edited", observedAt: "now", tokens: 350, tokenAttribution: "allocated" },
      { id: "i2", nodeId: "test", eventId: "e2", promptId: "prompt-agent", workflowRunId: null, agentRunId: "agent-child", operation: "execute", role: "delivery-reference", confidence: "observed", reason: "verified", observedAt: "now", tokens: 150, tokenAttribution: "allocated" }
    ],
    delivery: { capturedAt: "stop", baseline: { capturedAt: "start", head: null, workingTreeHash: "a", dirtyFiles: [] }, finalState: { capturedAt: "stop", head: null, workingTreeHash: "b", dirtyFiles: [] }, diff: "diff", touchedNodeIds: ["function", "test"], changedNodeIds: ["function"], deliveredNodeIds: ["function"], verifiedNodeIds: ["function"], referenceNodeIds: ["test"], revertedNodeIds: [], unrelatedTouchedNodeIds: [], pathNodeIds: ["function", "test"], pathEdgeIds: ["edge-test"], pathEventIds: ["e1", "e2"], tokenUsage: 500, allocatedTokens: 500, unallocatedTokens: 0, compliance: { expectedSkills: [], invokedSkills: [], missingSkills: [], expectedHooks: [], observedHooks: [], missingHooks: [] } }
  };

  const childEvidence = lifecycleEvidence(cycle, "agent", "agent-child");
  assert.equal(childEvidence.tokens, 500);
  assert.deepEqual(childEvidence.touchedNodeIds.sort(), ["function", "test"]);
  const display = scenarioGraph(repository, [], null, cycle, "delivery", "lifecycle:agent:agent-child");
  assert.ok(display.nodes.some((item) => item.id === "lifecycle:agent:agent-child"));
  assert.ok(display.nodes.some((item) => item.id === "delivery:function"));
  assert.ok(display.nodes.some((item) => item.id === "lifecycle:outcome:cycle-1"));
  assert.ok(display.edges.some((edge) => edge.source === "lifecycle:agent:agent-child" && edge.target === "delivery:function"));
  assert.ok(display.edges.some((edge) => edge.source === "lifecycle:agent:agent-child" && edge.target === "delivery:test"));
  assert.equal(countNodeCollisions(layoutDisplayGraph(display, "scenario", 1440)), 0);
});
