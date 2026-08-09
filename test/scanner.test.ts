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
