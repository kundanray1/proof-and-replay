import fs from "node:fs";
import type { TokenUsage } from "../types.js";

interface ClaudeUsageRecord {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
}

interface ClaudeTranscriptRecord {
  uuid?: unknown;
  message?: {
    id?: unknown;
    usage?: ClaudeUsageRecord;
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function usageFromRecord(record: ClaudeUsageRecord, source: TokenUsage["source"]): TokenUsage {
  const inputTokens = count(record.input_tokens);
  const outputTokens = count(record.output_tokens);
  const cacheCreationInputTokens = count(record.cache_creation_input_tokens);
  const cacheReadInputTokens = count(record.cache_read_input_tokens);
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
    observedAt: new Date().toISOString(),
    source
  };
}

export function readClaudeTokenUsage(transcriptPath: string | undefined): TokenUsage | null {
  if (!transcriptPath || !fs.existsSync(transcriptPath) || !fs.statSync(transcriptPath).isFile()) return null;
  const byMessage = new Map<string, TokenUsage>();
  const lines = fs.readFileSync(transcriptPath, "utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim()) continue;
    let record: ClaudeTranscriptRecord;
    try {
      record = JSON.parse(line) as ClaudeTranscriptRecord;
    } catch {
      continue;
    }
    if (!record.message?.usage) continue;
    const id = String(record.message.id ?? record.uuid ?? `line-${index}`);
    const usage = usageFromRecord(record.message.usage, "claude-transcript");
    const previous = byMessage.get(id);
    if (!previous || usage.totalTokens > previous.totalTokens) byMessage.set(id, usage);
  }
  if (byMessage.size === 0) return null;
  const total = [...byMessage.values()].reduce<TokenUsage>((sum, item) => ({
    inputTokens: sum.inputTokens + item.inputTokens,
    outputTokens: sum.outputTokens + item.outputTokens,
    cacheCreationInputTokens: sum.cacheCreationInputTokens + item.cacheCreationInputTokens,
    cacheReadInputTokens: sum.cacheReadInputTokens + item.cacheReadInputTokens,
    totalTokens: sum.totalTokens + item.totalTokens,
    observedAt: new Date().toISOString(),
    source: "claude-transcript"
  }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
    observedAt: new Date().toISOString(),
    source: "claude-transcript"
  });
  return total;
}

export function tokenUsageFromToolResponse(response: unknown): TokenUsage | null {
  if (!response || typeof response !== "object") return null;
  const candidate = response as { usage?: ClaudeUsageRecord; totalTokens?: unknown };
  if (!candidate.usage) return null;
  const usage = usageFromRecord(candidate.usage, "tool-response");
  const reportedTotal = count(candidate.totalTokens);
  return reportedTotal > usage.totalTokens ? { ...usage, totalTokens: reportedTotal } : usage;
}
