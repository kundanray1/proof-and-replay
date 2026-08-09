import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanProject } from "../src/core/scanner.js";
import { captureFileBaseline, finalizeSessionCycle, mapDiffToNodes } from "../src/core/sessions.js";
import { appendEvent, createRun, ensureState, readEvents, readSessionRecords } from "../src/core/store.js";

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-replay-session-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "feature.ts"), "export function feature(value: number) {\n  return value + 1;\n}\n");
  ensureState(root);
  scanProject(root);
  return root;
}

test("cycle delivery separates touched, delivered, referenced, and token-attributed nodes", () => {
  const root = project();
  const configFile = path.join(root, ".proof-replay", "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.workflowContracts = [{ id: "safe-edit", name: "Safe edit", promptIncludes: ["feature"], requiredSkills: ["typescript"], requiredHooks: ["PreToolUse:Edit"] }];
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

  const run = createRun(root, "Change the feature safely");
  const file = path.join(root, "src", "feature.ts");
  captureFileBaseline(root, run.cycleId, file);
  fs.writeFileSync(file, "export function feature(value: number) {\n  return value + 2;\n}\n");
  scanProject(root);
  const diff = "--- a/src/feature.ts\n+++ b/src/feature.ts\n@@ -1,3 +1,3 @@\n export function feature(value: number) {\n-  return value + 1;\n+  return value + 2;\n }";
  const changedNodeIds = mapDiffToNodes(root, diff);
  assert.ok(changedNodeIds.length >= 2);
  appendEvent(root, { runId: run.id, type: "hook.invoked", data: { hook: "PreToolUse", tool: "Edit" } });
  appendEvent(root, { runId: run.id, type: "skill.invoked", status: "completed", data: { skill: "typescript" } });
  appendEvent(root, { runId: run.id, type: "node.inspected", status: "active", nodeIds: changedNodeIds, data: { tool: "Read" } });
  appendEvent(root, { runId: run.id, type: "file.changed", status: "changed", nodeIds: changedNodeIds, data: { files: ["src/feature.ts"], diff, tool: "Edit" } });
  appendEvent(root, { runId: run.id, type: "usage.sampled", data: { deltaTokens: 1_200, totalTokens: 1_200 } });
  appendEvent(root, { runId: run.id, type: "node.executed", status: "passed", nodeIds: changedNodeIds, data: { stage: "verify" } });

  const delivery = finalizeSessionCycle(root, run.id, readEvents(root, run.id), "completed");
  assert.ok(delivery);
  assert.ok(delivery.deliveredNodeIds.length >= 2);
  assert.ok(delivery.verifiedNodeIds.length >= 2);
  assert.ok(delivery.touchedNodeIds.length >= delivery.deliveredNodeIds.length);
  assert.ok(delivery.allocatedTokens > 0);
  assert.deepEqual(delivery.compliance.missingSkills, []);
  assert.deepEqual(delivery.compliance.missingHooks, []);
  assert.ok(delivery.pathEventIds.length > 0);

  const cycle = readSessionRecords(root)[0]?.cycles[0];
  assert.ok(cycle?.interactions.some((interaction) => interaction.role === "delivered"));
  assert.ok(cycle?.interactions.some((interaction) => interaction.role === "verified"));
  assert.equal(cycle?.workflows[0]?.status, "completed");
});

test("a reverted edit is retained as exploration but excluded from delivery", () => {
  const root = project();
  const run = createRun(root, "Explore and revert the feature");
  const file = path.join(root, "src", "feature.ts");
  const original = fs.readFileSync(file, "utf8");
  captureFileBaseline(root, run.cycleId, file);
  fs.writeFileSync(file, original.replace("+ 1", "+ 9"));
  scanProject(root);
  const graph = scanProject(root);
  const nodeIds = graph.nodes.filter((node) => node.file === "src/feature.ts").map((node) => node.id);
  appendEvent(root, { runId: run.id, type: "file.changed", status: "changed", nodeIds, data: { files: ["src/feature.ts"], tool: "Edit" } });
  fs.writeFileSync(file, original);
  scanProject(root);

  const delivery = finalizeSessionCycle(root, run.id, readEvents(root, run.id), "stopped");
  assert.ok(delivery);
  assert.deepEqual(delivery.deliveredNodeIds, []);
  assert.ok(delivery.revertedNodeIds.length > 0);
  assert.ok(readSessionRecords(root)[0]?.cycles[0]?.interactions.some((interaction) => interaction.role === "reverted"));
});

test("a deleted file remains part of the delivered node set", () => {
  const root = project();
  const run = createRun(root, "Remove the obsolete feature");
  const file = path.join(root, "src", "feature.ts");
  const graph = scanProject(root);
  const originalNodeIds = graph.nodes.filter((node) => node.file === "src/feature.ts").map((node) => node.id);
  captureFileBaseline(root, run.cycleId, file);
  fs.unlinkSync(file);
  scanProject(root);
  const diff = "--- a/src/feature.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-export function feature(value: number) {\n-  return value + 1;\n-}";
  const mapped = mapDiffToNodes(root, diff, originalNodeIds);
  assert.deepEqual(new Set(mapped), new Set(originalNodeIds));
  appendEvent(root, { runId: run.id, type: "file.changed", status: "changed", nodeIds: mapped, data: { files: ["src/feature.ts"], tool: "Bash", diff } });

  const delivery = finalizeSessionCycle(root, run.id, readEvents(root, run.id), "stopped");
  assert.ok(delivery);
  assert.deepEqual(new Set(delivery.deliveredNodeIds), new Set(originalNodeIds));
  assert.deepEqual(delivery.revertedNodeIds, []);
});
