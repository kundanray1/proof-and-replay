import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendEvent, createRun, ensureState, readEvents, readRuns, readSessionRecords } from "../src/core/store.js";

test("event ledger is append-only and monotonically sequenced", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-replay-store-"));
  ensureState(root);
  const run = createRun(root, "Fix the broken behavior");
  appendEvent(root, { runId: run.id, type: "diagnosis.recorded", data: { summary: "Cause" } });

  const events = readEvents(root, run.id);
  assert.deepEqual(events.map((event) => event.seq), [1, 2]);
  assert.ok(events[0]);
  assert.equal(events[0].type, "task.started");
  assert.equal(events[0].sessionId, run.sessionId);
  assert.equal(events[0].cycleId, run.cycleId);
  const storedRun = readRuns(root)[0];
  assert.ok(storedRun);
  assert.equal(storedRun.prompt, "Fix the broken behavior");
  const session = readSessionRecords(root)[0];
  assert.equal(session?.cycles[0]?.runId, run.id);
  assert.equal(session?.cycles[0]?.prompts[0]?.text, "Fix the broken behavior");
});
