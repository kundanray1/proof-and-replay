import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { scanProject } from "../src/core/scanner.js";
import { ensureState } from "../src/core/store.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-replay-scan-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "math.js"),
    "export function add(a, b) { return a + b; }\nexport const twice = (n) => add(n, n);\n"
  );
  fs.writeFileSync(
    path.join(root, "test", "math.test.js"),
    "import { twice } from '../src/math.js';\ntest('doubles', () => twice(2));\n"
  );
  ensureState(root);
  return root;
}

test("scanner builds file, function, test, import, and call relationships", () => {
  const root = fixture();
  const graph = scanProject(root);

  assert.equal(graph.stats.files, 2);
  assert.equal(graph.stats.functions, 2);
  assert.equal(graph.stats.tests, 1);
  assert.ok(graph.nodes.some((node) => node.label === "add"));
  assert.ok(graph.nodes.some((node) => node.label === "twice"));
  assert.ok(graph.nodes.some((node) => node.label === "doubles"));
  assert.ok(graph.edges.some((edge) => edge.kind === "imports"));
  assert.ok(graph.edges.some((edge) => edge.kind === "calls"));
});

test("scanner discovers monorepo projects, HTTP routes, pages, and handlers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-replay-architecture-"));
  fs.mkdirSync(path.join(root, "backend", "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "frontend", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "workspace" }));
  fs.writeFileSync(path.join(root, "backend", "package.json"), JSON.stringify({ name: "api", dependencies: { express: "latest" } }));
  fs.writeFileSync(path.join(root, "frontend", "package.json"), JSON.stringify({ name: "web", dependencies: { react: "latest", "react-router-dom": "latest" } }));
  fs.writeFileSync(
    path.join(root, "backend", "src", "server.ts"),
    "function listUsers() { return []; }\nrouter.get('/users', listUsers);\n"
  );
  fs.writeFileSync(
    path.join(root, "frontend", "src", "App.tsx"),
    "const Settings = () => <main />;\nexport const App = () => <Route path=\"/settings\" element={<Settings />} />;\n"
  );
  ensureState(root);

  const graph = scanProject(root);
  assert.equal(graph.stats.projects, 3);
  assert.equal(graph.stats.routes, 2);
  assert.ok(graph.architecture?.projects.some((project) => project.name === "api" && project.kind === "service"));
  assert.ok(graph.architecture?.routes.some((route) => route.method === "GET" && route.path === "/users"));
  assert.ok(graph.architecture?.routes.some((route) => route.method === "PAGE" && route.path === "/settings"));
  assert.ok(graph.edges.some((edge) => edge.kind === "handles" && edge.data.confidence === "high"));
});
