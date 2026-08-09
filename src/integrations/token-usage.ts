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
  timestamp?: unknown;
  sessionId?: unknown;
  agentId?: unknown;
  toolUseResult?: unknown;
  message?: {
    id?: unknown;
    usage?: ClaudeUsageRecord;
    content?: unknown;
  };
}

interface ToolUseBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
}

export interface ClaudeWorkflowActivity {
  toolUseId: string;
  type: "agent.spawned" | "agent.completed" | "workflow.task.created" | "workflow.task.updated" | "workflow.task.stopped" | "agent.output";
  status: "completed" | "failed" | "observed" | "running";
  observedAt: string;
  data: Record<string, unknown>;
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

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function readClaudeWorkflowActivities(transcriptPath: string | undefined): ClaudeWorkflowActivity[] {
  if (!transcriptPath || !fs.existsSync(transcriptPath) || !fs.statSync(transcriptPath).isFile()) return [];
  const uses = new Map<string, { name: string; input: Record<string, unknown>; observedAt: string; parentLaneId: string }>();
  const results = new Map<string, Record<string, unknown>>();
  for (const line of fs.readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record: ClaudeTranscriptRecord;
    try { record = JSON.parse(line) as ClaudeTranscriptRecord; } catch { continue; }
    const content = Array.isArray(record.message?.content) ? record.message.content as ToolUseBlock[] : [];
    for (const block of content) {
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string" && ["Agent", "TaskCreate", "TaskUpdate", "TaskStop", "TaskOutput"].includes(block.name)) {
        uses.set(block.id, {
          name: block.name,
          input: object(block.input),
          observedAt: typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString(),
          parentLaneId: String(record.agentId ?? record.sessionId ?? "main")
        });
      }
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") results.set(block.tool_use_id, object(record.toolUseResult));
    }
  }
  return [...uses].map(([toolUseId, use]): ClaudeWorkflowActivity => {
    const response = results.get(toolUseId) ?? {};
    const task = object(response.task);
    const laneId = String(response.agentId ?? response.taskId ?? response.task_id ?? task.id ?? use.input.taskId ?? use.input.task_id ?? toolUseId);
    const shared = {
      toolUseId,
      laneId,
      parentLaneId: use.parentLaneId,
      description: use.input.description,
      subject: use.input.subject ?? task.subject,
      agentType: response.agentType ?? use.input.subagent_type,
      model: response.resolvedModel ?? use.input.model,
      background: response.isAsync ?? use.input.run_in_background,
      taskId: response.taskId ?? response.task_id ?? task.id ?? use.input.taskId ?? use.input.task_id,
      taskStatus: use.input.status ?? response.statusChange,
      totalTokens: response.totalTokens,
      totalToolUseCount: response.totalToolUseCount,
      durationMs: response.totalDurationMs
    };
    if (use.name === "Agent") return {
      toolUseId,
      type: response.status === "completed" ? "agent.completed" : "agent.spawned",
      status: response.status === "completed" ? "completed" : "running",
      observedAt: use.observedAt,
      data: shared
    };
    if (use.name === "TaskCreate") return { toolUseId, type: "workflow.task.created", status: "observed", observedAt: use.observedAt, data: shared };
    if (use.name === "TaskUpdate") return { toolUseId, type: "workflow.task.updated", status: "observed", observedAt: use.observedAt, data: shared };
    if (use.name === "TaskStop") return { toolUseId, type: "workflow.task.stopped", status: "completed", observedAt: use.observedAt, data: shared };
    return { toolUseId, type: "agent.output", status: "observed", observedAt: use.observedAt, data: shared };
  });
}
