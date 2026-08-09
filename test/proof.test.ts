import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateProof, finishRun } from "../src/core/proof.js";
import { appendEvent, createRun, ensureState, getRun } from "../src/core/store.js";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-replay-proof-"));
  ensureState(root);
  return { root, run: createRun(root, "Fix the premium discount") };
}

test("proof passes only when evidence is causally ordered", () => {
  const { root, run } = setup();
  appendEvent(root, { runId: run.id, type: "test.completed", status: "failed", nodeIds: ["fn:discount"], data: { stage: "reproduce" } });
  appendEvent(root, { runId: run.id, type: "file.changed", status: "changed", nodeIds: ["fn:discount"], data: { files: ["pricing.js"] } });
  appendEvent(root, { runId: run.id, type: "node.executed", nodeIds: ["fn:discount"], data: { stage: "verify" } });
  appendEvent(root, { runId: run.id, type: "test.completed", status: "passed", nodeIds: ["fn:discount"], data: { stage: "verify" } });

  const proof = finishRun(root, run.id);
  assert.equal(proof.passed, true);
  const completedRun = getRun(root, run.id);
  assert.ok(completedRun);
  assert.equal(completedRun.status, "completed");
});

test("proof blocks a passing test without reproduction evidence", () => {
  const { root, run } = setup();
  appendEvent(root, { runId: run.id, type: "file.changed", status: "changed", nodeIds: ["fn:discount"] });
  appendEvent(root, { runId: run.id, type: "node.executed", nodeIds: ["fn:discount"], data: { stage: "verify" } });
  appendEvent(root, { runId: run.id, type: "test.completed", status: "passed", nodeIds: ["fn:discount"], data: { stage: "verify" } });

  const proof = evaluateProof(root, run.id);
  assert.equal(proof.passed, false);
  const reproductionCheck = proof.checks.find((check) => check.id === "reproduction");
  assert.ok(reproductionCheck);
  assert.equal(reproductionCheck.passed, false);
});
