import { appendEvent, getRun, readConfig, readEvents, updateRun } from "./store.js";
import { closeSession, finalizeSessionCycle } from "./sessions.js";
import type { LedgerEvent, ProofResult } from "../types.js";

function firstAfter(
  events: LedgerEvent[],
  type: string,
  afterSeq = 0,
  predicate: (event: LedgerEvent) => boolean = () => true
): LedgerEvent | undefined {
  return events.find(
    (event) => event.seq > afterSeq && event.type === type && predicate(event)
  );
}

export function evaluateProof(root: string, runId: string): ProofResult {
  const run = getRun(root, runId);
  if (!run) throw new Error(`Unknown run: ${runId}`);
  const events = readEvents(root, runId).sort((a, b) => a.seq - b.seq);
  const policy = readConfig(root).proofPolicy;

  const reproduction = firstAfter(
    events,
    "test.completed",
    0,
    (event) => event.status === "failed" && event.data.stage === "reproduce"
  );
  const change = firstAfter(events, "file.changed", reproduction?.seq ?? 0);
  const verification = firstAfter(
    events,
    "test.completed",
    change?.seq ?? 0,
    (event) => event.status === "passed" && event.data.stage === "verify"
  );

  const changedNodeIds = new Set(change?.nodeIds ?? []);
  const execution = events.find(
    (event) =>
      event.seq > (change?.seq ?? Number.MAX_SAFE_INTEGER) &&
      event.type === "node.executed" &&
      event.nodeIds.some((nodeId) => changedNodeIds.has(nodeId))
  );

  const checks = [
    {
      id: "reproduction",
      label: "Original failure reproduced",
      required: policy.requireReproduction,
      passed: Boolean(reproduction),
      evidenceEventId: reproduction?.id ?? null
    },
    {
      id: "change",
      label: "Code change recorded after reproduction",
      required: policy.requireChange,
      passed: Boolean(change),
      evidenceEventId: change?.id ?? null
    },
    {
      id: "passing-verification",
      label: "Verification passed after the change",
      required: policy.requirePassingVerification,
      passed: Boolean(verification),
      evidenceEventId: verification?.id ?? null
    },
    {
      id: "changed-node-executed",
      label: "Changed code executed during verification",
      required: policy.requireExecutedChangedNode,
      passed: Boolean(execution),
      evidenceEventId: execution?.id ?? null
    }
  ];

  return {
    runId,
    passed: checks.every((check) => !check.required || check.passed),
    checks,
    eventCount: events.length,
    evaluatedAt: new Date().toISOString()
  };
}

export function finishRun(root: string, runId: string): ProofResult {
  const proof = evaluateProof(root, runId);
  appendEvent(root, {
    runId,
    type: proof.passed ? "verification.passed" : "verification.failed",
    status: proof.passed ? "passed" : "failed",
    data: { checks: proof.checks }
  });
  appendEvent(root, {
    runId,
    type: proof.passed ? "task.completed" : "task.blocked",
    status: proof.passed ? "passed" : "blocked",
    data: { proof }
  });
  updateRun(root, runId, {
    status: proof.passed ? "completed" : "blocked",
    completedAt: new Date().toISOString(),
    proof
  });
  finalizeSessionCycle(root, runId, readEvents(root, runId), proof.passed ? "completed" : "blocked");
  const run = getRun(root, runId);
  if (run) closeSession(root, run.sessionId, "completed");
  return proof;
}
