# Claude Code provider notes

EIGENT drives Claude Code through its stream-JSON CLI interface and uses the Claude CLI's own subscription authentication. The adapter does not require an Anthropic API key when Claude Code is already authenticated.

## Supported path

The current integration is tested against Claude Code 2.1.x behavior. Check the host first:

```bash
claude --version
claude auth status
```

EIGENT starts a non-interactive stream-JSON turn with the selected model/workspace, normalizes system/assistant/result events into the common agent event stream, and maps provider failures (including quota/auth HTTP failures) to a durable run error instead of silently dropping the CLI result. Interrupt/resume is handled by the provider/session lifecycle rather than by an interactive terminal prompt.

The package regression suite includes stream parsing and provider-error normalization:

```bash
bun test packages/agent-claude/src/index.test.ts
```

## Real E2E check

A real completion requires a Claude Code account that currently has usable subscription/provider quota. A minimal CLI stream check can be run outside EIGENT first; then create a Claude session through `/api/agents/sessions` and send a message through `/api/agents/sessions/:id/messages`.

If the CLI returns HTTP 403 with a provider message indicating zero/insufficient quota, authentication and stream startup may still be working correctly, but the E2E completion criterion is **not** satisfied. Re-authentication does not fix an account whose backend quota is actually zero; restore/renew usable quota and rerun the same E2E test.

When diagnosing an exit-code-1 result, retain the normalized stderr/provider error but never log OAuth credentials, cookies, authorization headers, or complete environment variables.
