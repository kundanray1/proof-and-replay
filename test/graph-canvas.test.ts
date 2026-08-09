import assert from "node:assert/strict";
import test from "node:test";
import {
  connectedNeighborhood,
  countNodeCollisions,
  layoutDisplayGraph,
  routeDisplayEdge,
  type DisplayEdge,
  type DisplayGraph,
  type DisplayNode
} from "../src/ui/components/GraphCanvas.js";

function node(id: string, kind: NonNullable<DisplayNode["kind"]>): DisplayNode {
  return { id, kind, label: id, kicker: kind, status: "planned" };
}

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
