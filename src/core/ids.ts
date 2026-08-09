import { createHash, randomUUID } from "node:crypto";

export function stableId(kind: string, ...parts: string[]): string {
  const digest = createHash("sha1")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 14);
  return `${kind}:${digest}`;
}

export function eventId(): string {
  return `evt_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

export function runId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `run_${stamp}_${randomUUID().slice(0, 6)}`;
}
