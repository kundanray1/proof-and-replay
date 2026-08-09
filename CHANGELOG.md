# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No unreleased changes.

## [0.3.0] - 2026-08-09

### Added

- Canvas-first trace explorer with mouse/touch panning, wheel and pinch zoom, fit controls, collapsible edge overlays, labeled relationships, and selected-node context bubbles.
- TypeScript interfaces, type aliases, enums, classes, and common schema declarations as first-class data-model nodes.
- Function signatures, parameter declarations, return types, call-site argument expressions, data-model relationships, and V8 execution counts.
- Horizontal workflow lanes reconstructed from Claude Agent and task transcript metadata, plus hooks for future subagent lifecycle events.
- Bounded code-diff evidence for Claude Edit, Write, and recognizable shell mutations.
- Persistent in-app token alarms, catch-up notification delivery after permission is granted, threshold-level deduplication, and an explicit alert test action.

### Changed

- Anonymous callbacks now receive contextual names derived from their call site, including HTTP route handler names.
- The project and selected-context panels now float at the canvas edges and can be hidden independently.

## [0.2.0] - 2026-08-09

### Added

- Whole-repository mental model with monorepo project boundaries, framework signals, project statistics, and cross-project dependency edges.
- Express HTTP and middleware route discovery plus React Router page discovery, with route-to-handler relationships and inspectable confidence reasons.
- Dedicated Mental model, Live scenario, Routes, and Evidence views with project scoping, semantic drill-down, route filtering, and graph zoom controls.
- Claude transcript token telemetry for input, output, cache creation, cache reads, session totals, and per-sample growth.
- Configurable high-token and growth thresholds with visible warnings and browser notifications that are enabled only after an explicit user permission action.

### Changed

- Claude shell activity is mapped to referenced project and file nodes, including inferred file changes and Playwright/Cypress test commands.
- Default scanning excludes nested worktrees, generated browser reports, Wrangler output, and common cache directories.

## [0.1.0] - 2026-08-09

### Added

- Strict TypeScript implementation, public declarations, ESM exports, and source maps.
- JavaScript and TypeScript AST scanner for files, functions, tests, imports, and conservative call edges.
- Append-only NDJSON evidence ledger with stable run, event, node, and edge identities.
- Causally ordered proof policy for reproduction, change, execution, and passing verification.
- V8 coverage collection mapped to indexed functions and tests.
- React dashboard with live updates, proof graph, activated code map, event inspector, and animated replay.
- Claude Code hook installer and attach/detach workflow.
- Vendor-neutral event command and programmatic package API.
- Demonstration project, generic multi-monorepo integration guide, automated tests, and CI.

[Unreleased]: https://github.com/kundanray1/proof-and-replay/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/kundanray1/proof-and-replay/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kundanray1/proof-and-replay/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/kundanray1/proof-and-replay/releases/tag/v0.1.0
