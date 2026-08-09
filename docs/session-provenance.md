# Session provenance and workflow contracts

Proof & Replay stores agent work as a hierarchy instead of treating a coding conversation as one flat event list.

```text
Session
└── Prompt cycle
    ├── User and nested prompts
    ├── Workflow runs
    ├── Main and nested agent runs
    ├── Skill and hook invocations
    ├── Node interactions
    └── Delivery snapshot
```

## Lifecycle boundaries

A provider conversation maps to one Proof & Replay session. The first recorded user prompt starts cycle 1. Claude `Stop` closes that cycle and calculates its delivery snapshot. A later `UserPromptSubmit` from the same Claude session starts the next cycle beneath the same session. Nested Agent and Task operations remain children of the cycle in which they occurred.

`proof-replay finish` closes the proof cycle and session explicitly. `proof-replay claude detach` records a detached cycle and closes the local session record without removing Claude's hooks.

## Stored evidence

The append-only source ledger remains `.proof-replay/events.ndjson`. Mutable, reproducible session projections are stored in `.proof-replay/sessions.json`. Mutation baselines are stored beneath `.proof-replay/baselines/<cycle-id>/` and are excluded from repository scanning.

New events carry `sessionId`, `cycleId`, `promptId`, `workflowRunId`, `agentRunId`, and `parentEventId` context fields. Older runs are migrated into compatible session and cycle records when the sessions API is first read; the original event lines are not rewritten.

Inspect the hierarchy from the terminal:

```bash
npx proof-replay sessions
npx proof-replay session --session session_...
```

Or use `GET /api/sessions` and `GET /api/session?id=session_...` from a local dashboard integration.

## Node roles

Node interactions retain the original action and acquire a final role when the cycle stops:

| Role | Meaning |
| --- | --- |
| `touched` | Read, searched, or referenced during active exploration |
| `executed` | Observed in a command, test, or V8 execution event |
| `changed` | Intersected an intermediate edit record |
| `delivered` | Intersects a diff that remains at cycle completion |
| `verified` | Delivered node executed after the final change |
| `delivery-reference` | Unchanged structural or semantic node needed to explain the delivery |
| `reverted` | Changed during the cycle but absent from its final diff |
| `unrelated-touch` | Explored but excluded from the final delivery path |

Reference closure is deliberately bounded. Structural parents, route handlers, data-model relationships, and observed call/import/test relationships can be included; arbitrary transitive repository connections are not.

## Mutation baselines and final diffs

Claude `PreToolUse` handlers capture each file once before an Edit, Write, or recognizable Bash mutation. At `Stop`, Proof & Replay compares those source snapshots with the current files. This makes a reverted edit different from a delivered edit even if both appeared in intermediate hook output.

Run the attach command again after upgrading to install the baseline hook:

```bash
npx proof-replay claude attach --prompt "Continue the current task"
```

Then use `/hooks` in Claude Code to confirm `PreToolUse`, `PostToolUse`, `Stop`, `UserPromptSubmit`, and subagent handlers are active.

## Token attribution

Provider totals are observed at the agent or transcript level. When a new usage sample arrives, its delta is allocated across node interactions since the prior sample. Every node allocation is labeled `allocated`; it is not presented as an exact provider-reported function cost. Tokens that cannot be associated with an interaction remain in `unallocatedTokens`.

This separation allows workflow comparisons without claiming false precision.

## Workflow contracts

Add optional contracts to `.proof-replay/config.json`:

```json
{
  "workflowContracts": [
    {
      "id": "safe-typescript-fix",
      "name": "Safe TypeScript fix",
      "promptIncludes": ["fix"],
      "requiredSkills": ["typescript", "testing"],
      "requiredHooks": ["PreToolUse:Edit", "PostToolUse:Skill", "Stop"]
    }
  ]
}
```

An empty `promptIncludes` array applies the contract to every new cycle. Otherwise every listed term must appear in the prompt, case-insensitively. Hook requirements can name the lifecycle hook (`Stop`) or a hook/tool pair (`PreToolUse:Edit`). At finalization, the delivery snapshot records expected, observed, and missing skills and hooks. A workflow with unmet requirements is marked `missed` rather than silently treated as completed.

Contracts observe compliance; they do not execute missing skills or interfere with the coding agent.
