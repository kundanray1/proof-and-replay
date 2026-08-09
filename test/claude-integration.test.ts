import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { attachClaude, installClaudeHooks } from "../src/integrations/claude.js";
import { readEvents } from "../src/core/store.js";

const HOOK = fileURLToPath(new URL("../src/integrations/claude-hook.ts", import.meta.url));
const TSX_IMPORT = import.meta.resolve("tsx");

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-replay-claude-"));
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude", "settings.local.json"),
    `${JSON.stringify({ permissions: { allow: ["Bash(npm test)"] } }, null, 2)}\n`
  );
  fs.writeFileSync(path.join(root, "src", "feature.js"), "export function feature() { return true; }\n");
  return root;
}

test("Claude installer preserves settings and hook records live activity", () => {
  const root = project();
  const installed = installClaudeHooks(root);
  const settings = JSON.parse(fs.readFileSync(installed.settingsFile, "utf8"));
  assert.deepEqual(settings.permissions.allow, ["Bash(npm test)"]);
  assert.equal(installed.changes, 6);
  assert.equal(installClaudeHooks(root).changes, 0);

  const run = attachClaude(root, "Continue fixing the feature");
  const hookInput = {
    session_id: "claude-session-1",
    cwd: root,
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_input: { file_path: path.join(root, "src", "feature.js") },
    tool_response: { success: true }
  };
  const result = spawnSync(process.execPath, ["--import", TSX_IMPORT, HOOK], {
    cwd: root,
    input: JSON.stringify(hookInput),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  const event = readEvents(root, run.id).find((candidate) => candidate.type === "node.inspected");
  assert.ok(event);
  assert.ok(event.nodeIds.length >= 1);
});

test("Claude hook records agent lanes and exact edit evidence", () => {
  const root = project();
  installClaudeHooks(root);
  const run = attachClaude(root, "Delegate and edit the feature");
  const agent = spawnSync(process.execPath, ["--import", TSX_IMPORT, HOOK], {
    cwd: root,
    input: JSON.stringify({
      session_id: "main-session",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_use_id: "tool-agent-1",
      tool_input: { description: "Inspect the feature", subagent_type: "Explore", run_in_background: true },
      tool_response: { agentId: "agent-42", status: "running", resolvedModel: "sonnet" }
    }),
    encoding: "utf8"
  });
  assert.equal(agent.status, 0);

  const edit = spawnSync(process.execPath, ["--import", TSX_IMPORT, HOOK], {
    cwd: root,
    input: JSON.stringify({
      session_id: "main-session",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_use_id: "tool-edit-1",
      tool_input: { file_path: path.join(root, "src", "feature.js"), old_string: "return true", new_string: "return false" }
    }),
    encoding: "utf8"
  });
  assert.equal(edit.status, 0);

  const events = readEvents(root, run.id);
  const spawned = events.find((event) => event.type === "agent.spawned");
  const changed = events.find((event) => event.type === "file.changed");
  assert.equal(spawned?.data.laneId, "agent-42");
  assert.match(String(changed?.data.diff), /-return true/);
  assert.match(String(changed?.data.diff), /\+return false/);
});
