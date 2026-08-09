# Security policy

## Supported versions

The latest `0.1.x` release receives security fixes while the project is in prototype status.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to **Kundan Ray** at [raykundan57@gmail.com](mailto:raykundan57@gmail.com). Do not include exploit details in a public issue.

Include the affected version, operating system, reproduction steps, impact, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Operational considerations

- The dashboard binds to `127.0.0.1` by default and does not provide authentication. Do not expose it directly to an untrusted network.
- `.proof-replay/events.ndjson` may contain prompts, file paths, and shell command text. Treat it as repository-sensitive data.
- Claude Code integration modifies `.claude/settings.local.json` by merging hook entries. Review hook configuration before enabling it in a sensitive environment.
- Never commit GitHub, npm, or other access tokens. Use environment variables or the platform's encrypted secret store.
