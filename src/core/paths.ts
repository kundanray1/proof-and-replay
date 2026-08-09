import path from "node:path";
import type { StatePaths } from "../types.js";

export const STATE_DIRECTORY = ".proof-replay";

export function resolveProjectRoot(input: string = process.cwd()): string {
  return path.resolve(input);
}

export function statePaths(root: string): StatePaths {
  const directory = path.join(root, STATE_DIRECTORY);
  return {
    directory,
    config: path.join(directory, "config.json"),
    graph: path.join(directory, "graph.json"),
    events: path.join(directory, "events.ndjson"),
    runs: path.join(directory, "runs.json"),
    claudeActive: path.join(directory, "claude-active.json"),
    coverage: path.join(directory, "coverage")
  };
}

export function toProjectPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}
