#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, createRun, ensureState, getRun, readEvents, readGraph, readSessionRecords, resetState } from "./core/store.js";
import { scanProject } from "./core/scanner.js";
import { runTests } from "./core/coverage.js";
import { finishRun } from "./core/proof.js";
import { captureFileBaseline } from "./core/sessions.js";
import { resolveProjectRoot, toProjectPath } from "./core/paths.js";
import { createDashboardServer } from "./server.js";
import { attachClaude, detachClaude, installClaudeHooks } from "./integrations/claude.js";
import type { EventStatus } from "./types.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

function option(args: readonly string[], name: string): string | undefined;
function option(args: readonly string[], name: string, fallback: string): string;
function option(
  args: readonly string[],
  name: string,
  fallback?: string
): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function valuesAfterDoubleDash(args: readonly string[]): string[] {
  const index = args.indexOf("--");
  return index === -1 ? [] : args.slice(index + 1);
}

function positional(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "--") break;
    if (["--root", "--port", "--prompt", "--run", "--session", "--stage", "--type", "--status", "--data", "--summary", "--node"].includes(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith("--")) result.push(value);
  }
  return result;
}

function requireOption(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

function eventStatus(value: string): EventStatus {
  const statuses: readonly EventStatus[] = [
    "active", "blocked", "changed", "completed", "failed",
    "observed", "passed", "planned", "running"
  ];
  if (!statuses.includes(value as EventStatus)) {
    throw new Error(`Unknown event status: ${value}`);
  }
  return value as EventStatus;
}

function printHelp(): void {
  console.log(`
Proof & Replay — evidence and replay for AI-written code

Usage:
  proof-replay init [--root path]
  proof-replay scan [--root path]
  proof-replay serve [--root path] [--port 4177]
  proof-replay start --prompt "Fix the bug" [--root path]
  proof-replay diagnose --run id --summary "Cause" [--node node-id]
  proof-replay change --run id <file...>
  proof-replay test --run id --stage reproduce|verify -- <test command>
  proof-replay finish --run id
  proof-replay replay --run id
  proof-replay sessions
  proof-replay session --session id
  proof-replay event --run id --type name [--status status] [--data json]
  proof-replay claude install [--root path]
  proof-replay claude attach --prompt "Current task" [--root path]
  proof-replay claude detach [--root path]
  proof-replay demo [--port 4177] [--no-serve]
`);
}

function rootFrom(args: readonly string[]): string {
  return resolveProjectRoot(option(args, "--root", process.cwd()));
}

function assertRun(root: string, runId: string): asserts runId is string {
  if (!getRun(root, runId)) throw new Error(`Unknown run: ${runId}`);
}

function changedNodeIds(root: string, files: readonly string[]): string[] {
  const graph = readGraph(root) ?? scanProject(root);
  const normalized = new Set(
    files.map((file) => toProjectPath(root, path.resolve(root, file)))
  );
  return graph.nodes
    .filter((node) => normalized.has(node.file))
    .map((node) => node.id);
}

async function runDemo(args: readonly string[]): Promise<void> {
  const demoRoot = path.join(process.cwd(), ".proof-replay", "demo-project");
  const templateRoot = path.join(PACKAGE_ROOT, "examples", "discount-bug");
  fs.rmSync(demoRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(demoRoot), { recursive: true });
  fs.cpSync(templateRoot, demoRoot, { recursive: true });
  ensureState(demoRoot);
  resetState(demoRoot);
  scanProject(demoRoot);

  const run = createRun(demoRoot, "Fix the premium customer discount regression");
  const reproduction = await runTests(demoRoot, {
    runId: run.id,
    stage: "reproduce",
    command: process.execPath,
    args: ["--test"]
  });
  if (reproduction.exitCode === 0) throw new Error("The demo bug did not reproduce");

  const graphBefore = readGraph(demoRoot) ?? scanProject(demoRoot);
  const target = graphBefore.nodes.find((node) => node.label === "applyPremiumDiscount");
  appendEvent(demoRoot, {
    runId: run.id,
    type: "diagnosis.recorded",
    status: "observed",
    nodeIds: target ? [target.id] : [],
    data: { summary: "The premium multiplier is 0.95 but the specification requires 0.80." }
  });

  const pricingFile = path.join(demoRoot, "src", "pricing.js");
  captureFileBaseline(demoRoot, run.cycleId, pricingFile);
  const buggySource = fs.readFileSync(pricingFile, "utf8");
  fs.writeFileSync(pricingFile, buggySource.replace("subtotal * 0.95", "subtotal * 0.8"), "utf8");
  scanProject(demoRoot);
  appendEvent(demoRoot, {
    runId: run.id,
    type: "file.changed",
    status: "changed",
    nodeIds: changedNodeIds(demoRoot, ["src/pricing.js"]),
    data: { files: ["src/pricing.js"], summary: "Corrected the premium discount multiplier." }
  });

  const verification = await runTests(demoRoot, {
    runId: run.id,
    stage: "verify",
    command: process.execPath,
    args: ["--test"]
  });
  if (verification.exitCode !== 0) throw new Error("The demo verification failed");
  const proof = finishRun(demoRoot, run.id);

  console.log(`\nDemo run: ${run.id}`);
  console.log(`Proof: ${proof.passed ? "PASSED" : "BLOCKED"}`);
  console.log(`Project: ${demoRoot}`);

  if (!hasFlag(args, "--no-serve")) {
    const dashboard = await createDashboardServer(demoRoot, { port: option(args, "--port", "4177") });
    console.log(`Dashboard: ${dashboard.url}`);
  }
}

async function main(): Promise<void> {
  const [, , command = "help", ...args] = process.argv;
  const root = rootFrom(args);

  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;

    case "init": {
      ensureState(root);
      const graph = scanProject(root);
      console.log(`Initialized ${root}`);
      console.log(`Indexed ${graph.stats.files} files, ${graph.stats.functions} functions, and ${graph.stats.tests} tests.`);
      break;
    }

    case "scan": {
      const graph = scanProject(root);
      console.log(JSON.stringify(graph.stats, null, 2));
      break;
    }

    case "serve": {
      ensureState(root);
      if (!readGraph(root)) scanProject(root);
      const dashboard = await createDashboardServer(root, { port: option(args, "--port", "4177") });
      console.log(`Proof & Replay dashboard: ${dashboard.url}`);
      console.log(`Watching: ${root}`);
      break;
    }

    case "start": {
      ensureState(root);
      if (!readGraph(root)) scanProject(root);
      const run = createRun(root, requireOption(args, "--prompt"));
      console.log(run.id);
      break;
    }

    case "diagnose": {
      const runId = requireOption(args, "--run");
      assertRun(root, runId);
      const nodeId = option(args, "--node");
      appendEvent(root, {
        runId,
        type: "diagnosis.recorded",
        status: "observed",
        nodeIds: nodeId ? [nodeId] : [],
        data: { summary: requireOption(args, "--summary") }
      });
      console.log("Diagnosis recorded.");
      break;
    }

    case "change": {
      const runId = requireOption(args, "--run");
      assertRun(root, runId);
      const files = positional(args);
      if (files.length === 0) throw new Error("Provide at least one changed file");
      scanProject(root);
      const event = appendEvent(root, {
        runId,
        type: "file.changed",
        status: "changed",
        nodeIds: changedNodeIds(root, files),
        data: { files }
      });
      console.log(`Recorded ${files.length} changed file(s) across ${event.nodeIds.length} graph nodes.`);
      break;
    }

    case "test": {
      const runId = requireOption(args, "--run");
      const stage = requireOption(args, "--stage");
      if (!["reproduce", "verify"].includes(stage)) throw new Error("--stage must be reproduce or verify");
      assertRun(root, runId);
      scanProject(root);
      const testCommand = valuesAfterDoubleDash(args);
      if (testCommand.length === 0) throw new Error("Provide a test command after --");
      const [testExecutable, ...testArguments] = testCommand;
      if (!testExecutable) throw new Error("Provide a test command after --");
      const result = await runTests(root, {
        runId,
        stage: stage as "reproduce" | "verify",
        command: testExecutable,
        args: testArguments
      });
      process.exitCode = result.exitCode;
      break;
    }

    case "finish": {
      const runId = requireOption(args, "--run");
      const proof = finishRun(root, runId);
      for (const check of proof.checks) console.log(`${check.passed ? "✓" : "✗"} ${check.label}`);
      console.log(proof.passed ? "Proof passed." : "Completion blocked: evidence is incomplete.");
      process.exitCode = proof.passed ? 0 : 2;
      break;
    }

    case "replay": {
      const runId = requireOption(args, "--run");
      assertRun(root, runId);
      for (const event of readEvents(root, runId)) {
        const detail = event.data.summary ?? event.data.command ?? "";
        console.log(`${String(event.seq).padStart(4, "0")}  ${event.status.padEnd(8)}  ${event.type.padEnd(24)} ${detail}`);
      }
      break;
    }

    case "sessions": {
      const sessions = readSessionRecords(root).toReversed().map((session) => ({
        id: session.id,
        provider: session.provider,
        status: session.status,
        startedAt: session.startedAt,
        cycles: session.cycles.length,
        prompts: session.cycles.reduce((sum, cycle) => sum + cycle.prompts.length, 0),
        deliveredNodes: new Set(session.cycles.flatMap((cycle) => cycle.delivery?.deliveredNodeIds ?? [])).size
      }));
      console.log(JSON.stringify(sessions, null, 2));
      break;
    }

    case "session": {
      const sessionId = requireOption(args, "--session");
      const session = readSessionRecords(root).find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error(`Unknown session: ${sessionId}`);
      console.log(JSON.stringify(session, null, 2));
      break;
    }

    case "event": {
      const runId = requireOption(args, "--run");
      assertRun(root, runId);
      const dataText = option(args, "--data", "{}");
      const nodeId = option(args, "--node");
      appendEvent(root, {
        runId,
        type: requireOption(args, "--type"),
        status: eventStatus(option(args, "--status", "observed")),
        nodeIds: nodeId ? [nodeId] : [],
        data: JSON.parse(dataText)
      });
      console.log("Event recorded.");
      break;
    }

    case "claude": {
      const action = positional(args)[0];
      if (action === "install") {
        const result = installClaudeHooks(root);
        console.log(`${result.changes === 0 ? "Claude hooks already installed" : `Installed ${result.changes} Claude hooks`}.`);
        console.log(`Settings: ${result.settingsFile}`);
      } else if (action === "attach") {
        const installed = installClaudeHooks(root);
        const run = attachClaude(root, requireOption(args, "--prompt"));
        console.log(run.id);
        if (installed.changes > 0) console.error("Claude hooks installed; run /hooks in Claude Code to confirm they are active.");
      } else if (action === "detach") {
        const run = detachClaude(root);
        console.log(run ? `Detached ${run.id}.` : "No Claude run is attached.");
      } else {
        throw new Error("Use: proof-replay claude install|attach|detach");
      }
      break;
    }

    case "demo":
      await runDemo(args);
      break;

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  console.error(`proof-replay: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
