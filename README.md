# Proof & Replay

[![CI](https://github.com/kundanray1/proof-and-replay/actions/workflows/ci.yml/badge.svg)](https://github.com/kundanray1/proof-and-replay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-43853d.svg)](package.json)

Proof & Replay is a local-first evidence graph for AI-written JavaScript and TypeScript. It records a coding task as an append-only sequence of prompts, test runs, executed functions, diagnoses, changes, and verification results. A task is complete only when its evidence satisfies a declared proof policy.

> Can we prove that an agent reproduced a bug, changed the relevant code, executed that code again, and passed verification—in the correct order?

![Animated Proof & Replay dashboard showing a bug-fix run](docs/assets/proof-and-replay-demo.gif)

Status: focused prototype (`0.1.x`). The event schema is versioned; the package API may still evolve before `1.0.0`.

## Install

Node.js 20 or newer is required.

Install from the public npm registry:

```bash
npm install --save-dev proof-and-replay
```

Install it in the repository being observed rather than relying on a temporary `npx` cache. That keeps agent-hook paths stable for every contributor.

## Quick start

```bash
npx proof-replay init
npx proof-replay serve
```

Open `http://127.0.0.1:4177`. In a second terminal, record a complete bug-fix proof:

```bash
RUN_ID=$(npx proof-replay start --prompt "Fix the premium discount regression")

npx proof-replay test --run "$RUN_ID" --stage reproduce -- node --test
npx proof-replay diagnose --run "$RUN_ID" --summary "The premium multiplier is incorrect"

# After the code is edited:
npx proof-replay change --run "$RUN_ID" src/pricing.ts
npx proof-replay test --run "$RUN_ID" --stage verify -- node --test
npx proof-replay finish --run "$RUN_ID"
```

The reproduction command is expected to return the test runner's non-zero exit code. That failure is evidence.

## Run the included demonstration

From a cloned copy of this project:

```bash
npm install
npm run demo
```

The demonstration creates an isolated project under `.proof-replay/demo-project`, runs a genuinely failing test, records a diagnosis, fixes the bug, reruns the test with V8 coverage, evaluates the proof contract, and starts the dashboard.

Use `npm run demo -- --no-serve` for terminal-only verification.

## Attach an existing Claude Code session

Install and attach the hooks from the root being observed:

```bash
npx proof-replay claude attach --prompt "Describe the task Claude is already working on"
```

Then enter `/hooks` in the existing Claude Code session and confirm that the Proof & Replay handlers appear. Continue coding normally. New prompts, reads, searches, edits, commands, test results, failures, and stop events are recorded. Events from before attachment cannot be reconstructed.

The installer merges handlers into `.claude/settings.local.json` and preserves existing settings. Detach the current task without uninstalling the hooks:

```bash
npx proof-replay claude detach
```

Claude's normal test commands are observed, but the strongest changed-function execution proof requires tests to run through `proof-replay test`, which enables V8 coverage.

## Super-repositories and monorepos

Initialize once at the common parent to visualize paths across multiple nested workspaces:

```text
platform/
├── package.json
├── web/                 # JavaScript/TypeScript monorepo
├── services/            # another JavaScript/TypeScript monorepo
└── .proof-replay/       # one shared graph and event ledger
```

```bash
cd platform
npm install --save-dev proof-and-replay
npx proof-replay init --root .
npx proof-replay serve --root .
```

Git submodules are indexed when they are checked out beneath the selected root. Generated output and dependency directories are excluded by default. See the [generic multi-monorepo integration guide](docs/multi-monorepo-integration.md) for npm, pnpm, Yarn, CI, Claude Code, and team-installation patterns.

## Proof contract

The default policy requires all four conditions:

1. A failing test was recorded in the `reproduce` stage.
2. A code change was recorded after that failure.
3. The changed code was executed after the change.
4. A passing test was recorded in the `verify` stage after the change.

`proof-replay finish` exits with status `2` when evidence is incomplete. A passing test alone is intentionally insufficient. The policy is stored in `.proof-replay/config.json` and can be adjusted per repository.

## What is included

- A TypeScript AST index of JavaScript and TypeScript files, functions, tests, imports, and conservatively resolvable calls
- Stable graph identities for files and callable symbols
- V8 coverage mapped back to indexed function and test nodes
- An append-only NDJSON execution ledger
- A causally ordered completion policy
- A React and strict-TypeScript dashboard with proof graph, code map, inspector, live updates, and replay
- A Claude Code bridge plus a vendor-neutral event command
- ESM package exports, generated declarations and source maps

Generated repository data stays under `.proof-replay/` and should remain ignored by Git.

## Vendor-neutral events

Any agent or editor hook can append structured activity:

```bash
npx proof-replay event \
  --run "$RUN_ID" \
  --type tool.completed \
  --status observed \
  --data '{"tool":"read_file","file":"src/pricing.ts"}'
```

The core ledger does not depend on an agent vendor. Additional adapters can emit the same schema.

## Programmatic TypeScript API

```ts
import { createRun, evaluateProof, scanProject } from "proof-and-replay";

const root = process.cwd();
const graph = scanProject(root);
const run = createRun(root, "Repair the failing checkout path");

console.log(graph.stats, evaluateProof(root, run.id));
```

Declarations are included with the package and checked under strict TypeScript settings.

## Architecture

```text
Repository source ──→ static code graph ───────────────┐
                                                       │
Agent/tool hooks ───→ append-only event ledger ────────┼──→ live graph + replay
                                                       │
Test process ───────→ V8 execution coverage ───────────┘
                               │
                               └──→ completion proof gate
```

The graph is observability. The proof policy is control.

## Current boundaries

- Static indexing targets JavaScript and TypeScript.
- Runtime mapping is most reliable when Node executes indexed JavaScript directly. Transpiled TypeScript will need source-map-aware coverage mapping.
- Call resolution is intentionally conservative. Ambiguous dynamic calls remain disconnected instead of inventing an edge.
- The ledger records evidence; it does not claim that every semantic behavior is statically knowable.
- The local dashboard binds to `127.0.0.1` by default and has no authentication. Do not expose it to an untrusted network.
- Prompt and command events may contain sensitive repository context. Review `.proof-replay/` before sharing it.

## Project standards

- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Publishing to npm](docs/publishing.md)
- [MIT license](LICENSE)

Maintained by **Kundan Ray** · [raykundan57@gmail.com](mailto:raykundan57@gmail.com)
