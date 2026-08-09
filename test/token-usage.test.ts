import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readClaudeTokenUsage, tokenUsageFromToolResponse } from "../src/integrations/token-usage.js";

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
