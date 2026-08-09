# Multi-monorepo integration

This guide covers a generic super-repository containing two or more JavaScript or TypeScript workspaces. It contains no assumptions about a particular private project.

## Choose one observation root

Run Proof & Replay at the lowest common parent of every workspace whose relationships should appear in one graph.

```text
platform/
├── package.json
├── frontend/
│   ├── package.json
│   └── packages/
├── backend/
│   ├── package.json
│   └── services/
└── shared/
```

Using `platform/` as the root creates one `.proof-replay/` ledger and lets import and call edges connect files across the entire checked-out tree. Running separately inside `frontend/` and `backend/` creates isolated graphs instead.

## Install from GitHub

Add the package to the super-repository so its hook path remains stable:

```bash
cd platform
npm install --save-dev github:kundanray1/proof-and-replay
```

For Yarn or pnpm roots:

```bash
yarn add --dev github:kundanray1/proof-and-replay
pnpm add --save-dev github:kundanray1/proof-and-replay
```

Commit the package manifest and lockfile. Do not commit `node_modules/` or `.proof-replay/`.

## Initialize and configure

```bash
npx proof-replay init --root .
```

This creates `.proof-replay/config.json`. The default scanner includes `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, and `.tsx`, and excludes common generated directories.

For a large super-repository, add project-specific generated directory names to `exclude`:

```json
{
  "schemaVersion": 1,
  "sourceExtensions": [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"],
  "exclude": [
    ".git",
    ".proof-replay",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    ".cache",
    "generated"
  ],
  "proofPolicy": {
    "requireReproduction": true,
    "requireChange": true,
    "requirePassingVerification": true,
    "requireExecutedChangedNode": true
  }
}
```

Exclusions currently match directory names, not glob expressions.

## Start the live dashboard

```bash
npx proof-replay serve --root . --port 4177
```

Open `http://127.0.0.1:4177`. The dashboard shows:

- the causally ordered proof path;
- code nodes activated by events and V8 coverage;
- the append-only event timeline;
- the completion contract and its evidence;
- an animated replay of the selected run.

The root defaults to the current working directory, so `--root .` may be omitted when commands always run from the super-repository root.

## Attach Claude Code

From the same root:

```bash
npx proof-replay claude attach --root . --prompt "Continue the current cross-workspace task"
```

In an already-running Claude Code session, enter `/hooks` and confirm that the new handlers are active. Only activity after attachment is recorded.

The installer merges into `.claude/settings.local.json`. It does not replace existing permissions or hooks. Use:

```bash
npx proof-replay claude detach --root .
```

to detach the current proof run while retaining the installed handlers.

## Record tests from each workspace

Start one run for the cross-workspace task:

```bash
RUN_ID=$(npx proof-replay start --root . --prompt "Fix the cross-workspace regression")
```

Use the package manager already standard for the repository. Examples:

```bash
# npm workspace
npx proof-replay test --root . --run "$RUN_ID" --stage reproduce -- \
  npm test --workspace frontend

# pnpm filter
npx proof-replay test --root . --run "$RUN_ID" --stage verify -- \
  pnpm --filter backend test

# Yarn workspace
npx proof-replay test --root . --run "$RUN_ID" --stage verify -- \
  yarn workspace shared test
```

Record every changed path relative to the observation root:

```bash
npx proof-replay change --root . --run "$RUN_ID" \
  frontend/src/client.ts \
  backend/src/handler.ts
```

Finish only after the required evidence exists:

```bash
npx proof-replay finish --root . --run "$RUN_ID"
```

## Git submodules

Checked-out Git submodules are ordinary directories to the scanner and can participate in one graph. Initialize them before scanning:

```bash
git submodule update --init --recursive
npx proof-replay scan --root .
```

Follow the super-repository's normal submodule safety rules. Proof & Replay does not run Git synchronization commands or modify submodule state.

## Team-friendly package scripts

Add stable shortcuts to the root `package.json`:

```json
{
  "scripts": {
    "proof:init": "proof-replay init --root .",
    "proof:scan": "proof-replay scan --root .",
    "proof:serve": "proof-replay serve --root . --port 4177"
  }
}
```

Developers can then run `npm run proof:serve` without learning the full CLI.

## CI evidence

The current prototype stores its ledger locally. CI can still use the proof gate and upload `.proof-replay/` as a diagnostic artifact:

```yaml
- name: Verify proof run
  run: npx proof-replay finish --run "$RUN_ID"

- name: Upload evidence
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: proof-replay-evidence
    path: .proof-replay/
```

Treat the artifact as potentially sensitive because prompts and shell command text can appear in the event ledger.

## What a disconnected graph means

A missing edge is a signal to investigate, not automatic proof of hallucination. Common causes include:

- dynamic imports or computed calls the conservative scanner cannot resolve;
- generated or excluded source;
- TypeScript transpilation without source-map-aware coverage;
- code changed but never executed in the verification stage;
- a tool used outside the attached agent or Proof & Replay command.

The proof gate uses recorded causal evidence. It deliberately avoids inventing a connection when the available data is ambiguous.
