import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readClaudeTokenUsage, readClaudeWorkflowActivities, tokenUsageFromToolResponse } from "../src/integrations/token-usage.js";

test("Claude transcript usage is deduplicated by assistant message", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proof-replay-usage-"));
  const transcript = path.join(directory, "session.jsonl");
  const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 };
  const rows = [
    { uuid: "one-a", message: { id: "message-one", usage } },
    { uuid: "one-b", message: { id: "message-one", usage } },
    { uuid: "two", message: { id: "message-two", usage: { input_tokens: 5, output_tokens: 7 } } }
  ];
  fs.writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = readClaudeTokenUsage(transcript);
  assert.equal(result?.inputTokens, 15);
  assert.equal(result?.outputTokens, 27);
  assert.equal(result?.cacheCreationInputTokens, 30);
  assert.equal(result?.cacheReadInputTokens, 40);
  assert.equal(result?.totalTokens, 112);
});

test("Agent tool usage accepts a reported aggregate total", () => {
  const result = tokenUsageFromToolResponse({
    totalTokens: 900,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 }
  });
  assert.equal(result?.totalTokens, 900);
  assert.equal(result?.source, "tool-response");
});

test("Claude transcript reconstructs agent workflow lanes without copying prompts", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "proof-replay-workflow-"));
  const transcript = path.join(directory, "session.jsonl");
  const rows = [
    {
      timestamp: "2026-08-09T01:00:00.000Z",
      sessionId: "main-session",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { description: "Inspect API routes", prompt: "private instructions", subagent_type: "Explore" } }] }
    },
    {
      message: { content: [{ type: "tool_result", tool_use_id: "agent-tool", content: "done" }] },
      toolUseResult: { status: "completed", agentId: "agent-7", resolvedModel: "sonnet", totalTokens: 4000 }
    }
  ];
  fs.writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const [activity] = readClaudeWorkflowActivities(transcript);
  assert.equal(activity?.type, "agent.completed");
  assert.equal(activity?.data.laneId, "agent-7");
  assert.equal(activity?.data.parentLaneId, "main-session");
  assert.equal(activity?.data.description, "Inspect API routes");
  assert.equal("prompt" in (activity?.data ?? {}), false);
});
