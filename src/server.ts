import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateProof } from "./core/proof.js";
import { ensureState, getRun, readEvents, readGraph, readRuns } from "./core/store.js";
import type { Server } from "node:http";
import type { ServerResponse } from "node:http";

const UI_DIRECTORY = fileURLToPath(new URL("./ui/", import.meta.url));

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

interface DashboardOptions {
  port?: number | string;
  host?: string;
}

interface DashboardClient {
  response: ServerResponse;
  runId: string | null;
}

export interface DashboardHandle {
  server: Server;
  url: string;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function serveStatic(requestPath: string, response: ServerResponse): void {
  const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const candidate = path.resolve(UI_DIRECTORY, relative);
  if (!candidate.startsWith(UI_DIRECTORY) || !fs.existsSync(candidate) || fs.statSync(candidate).isDirectory()) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  response.writeHead(200, {
    "content-type": MIME_TYPES[path.extname(candidate)] ?? "application/octet-stream",
    "cache-control": "no-store"
  });
  fs.createReadStream(candidate).pipe(response);
}

export function createDashboardServer(
  root: string,
  options: DashboardOptions = {}
): Promise<DashboardHandle> {
  ensureState(root);
  const clients = new Set<DashboardClient>();
  let lastBroadcastSeq = 0;

  function broadcastNewEvents() {
    let events;
    try {
      events = readEvents(root).filter((event) => event.seq > lastBroadcastSeq);
    } catch {
      return;
    }
    for (const event of events) {
      lastBroadcastSeq = Math.max(lastBroadcastSeq, event.seq);
      for (const client of clients) {
        if (client.runId && client.runId !== event.runId) continue;
        client.response.write(`id: ${event.seq}\n`);
        client.response.write(`event: proof-event\n`);
        client.response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }
  }

  const eventPoller = setInterval(broadcastNewEvents, 250);
  eventPoller.unref();

  const heartbeat = setInterval(() => {
    for (const client of clients) client.response.write(": heartbeat\n\n");
  }, 15_000);
  heartbeat.unref();

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    try {
      if (url.pathname === "/api/health") {
        sendJson(response, 200, { ok: true, root });
        return;
      }
      if (url.pathname === "/api/graph") {
        sendJson(response, 200, readGraph(root) ?? { nodes: [], edges: [], stats: {} });
        return;
      }
      if (url.pathname === "/api/runs") {
        sendJson(response, 200, readRuns(root).toReversed());
        return;
      }
      if (url.pathname === "/api/events") {
        sendJson(response, 200, readEvents(root, url.searchParams.get("runId") || undefined));
        return;
      }
      if (url.pathname === "/api/proof") {
        const runId = url.searchParams.get("runId");
        if (!runId || !getRun(root, runId)) {
          sendJson(response, 404, { error: "Unknown run" });
          return;
        }
        sendJson(response, 200, evaluateProof(root, runId));
        return;
      }
      if (url.pathname === "/api/stream") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        const after = Number(url.searchParams.get("after") ?? 0);
        const runId = url.searchParams.get("runId") || null;
        for (const event of readEvents(root, runId || undefined).filter((event) => event.seq > after)) {
          response.write(`id: ${event.seq}\n`);
          response.write(`event: proof-event\n`);
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        const client = { response, runId };
        clients.add(client);
        request.once("close", () => clients.delete(client));
        return;
      }
      serveStatic(url.pathname, response);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Unknown server error"
      });
    }
  });

  server.once("close", () => {
    clearInterval(eventPoller);
    clearInterval(heartbeat);
  });

  const port = Number(options.port ?? 4177);
  return new Promise<DashboardHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, options.host ?? "127.0.0.1", () => {
      resolve({ server, url: `http://${options.host ?? "127.0.0.1"}:${port}` });
    });
  });
}
