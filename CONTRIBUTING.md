# Contributing

Thank you for improving Proof & Replay.

## Development setup

Requirements:

- Node.js 20 or newer
- npm 10 or newer

```bash
git clone https://github.com/kundanray1/proof-and-replay.git
cd proof-and-replay
npm install
npm run check
npm run build
```

Run the end-to-end demonstration with `npm run demo`, or use `npm run demo -- --no-serve` when a browser is unnecessary.

## Quality requirements

Before opening a pull request:

1. Add or update tests for behavior changes.
2. Keep implementation, UI, and tests strictly typed.
3. Run `npm run check`.
4. Run `npm run build`.
5. Run `npm run pack:check` and inspect the published file list.
6. Add user-visible changes under `[Unreleased]` in `CHANGELOG.md`.
7. Do not commit `.proof-replay/`, coverage output, credentials, or private repository details.

Prefer conservative graph behavior: an unresolved relationship should remain disconnected rather than be inferred without evidence.

## Changes and releases

Use focused commits and describe observable behavior in pull requests. Versions follow Semantic Versioning. Maintainers move `[Unreleased]` entries into a dated version section as part of release preparation.

## Maintainer

Kundan Ray · [raykundan57@gmail.com](mailto:raykundan57@gmail.com)
