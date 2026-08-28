# EIGENT

EIGENT is a **web-first, self-hosted AI coding workspace** for running coding agents and computer-oriented development workflows from a browser. It is being built from the Palot codebase, with the goal of making a persistent personal coding environment that can expose files, terminals, processes, and multiple agent providers through one server.

> **Development status:** early work in progress. Core workspace/terminal APIs and the unified agent-driver layer exist, but the main chat UI is not yet fully migrated to the new agent API.

## Implemented so far

### Workspace and process tools

- Project-scoped filesystem API for listing, reading, writing, renaming, creating, and deleting files/directories.
- Workspace-root boundary checks to reject `../` path escapes.
- Long-running process manager with output capture, stdin, status, kill, and cleanup operations.
- Browser project tools page with **Files / Terminal / Processes** tabs.
- xterm.js terminal frontend over WebSocket.
- Unix/Ubuntu terminal backend uses a real `node-pty` PTY.
- Windows+Bun development uses a pipe fallback because of a native `node-pty` stdin compatibility issue.

### Unified agent adapters

The common `AgentDriver` / `AgentEvent` interface currently has adapters for:

- OpenAI Codex CLI
- Claude Code CLI
- OpenAI-compatible APIs
  - Responses API streaming
  - Chat Completions streaming
- Anthropic-compatible Messages API streaming

The server exposes provider discovery/status, session creation, SSE message streaming, interrupt/resume, and CLI-auth task endpoints under `/api/agents`.

### Current verification status

- Monorepo type-check passes.
- Production web/server build passes.
- Workspace API smoke tests passed, including root-escape rejection.
- Managed-process smoke test passed with captured output and exit code `0`.
- Terminal WebSocket input/output smoke test passed on Windows using the development fallback.
- Mock streaming tests passed for OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages.
- Claude Code OAuth login is detected successfully on the development machine.

Known blockers and remaining work are tracked in **GitHub Issues**.

## Quick start

Requirements:

- Bun
- Node.js tooling required by the inherited desktop/web packages
- OpenCode for the existing Palot/OpenCode path
- Optional: Claude Code and/or Codex CLI for those agent drivers
- On Ubuntu, native build dependencies required by `node-pty`

```bash
bun install
cp .env.example .env
bun run check-types
bun run build:web
bun run start
```

The server listens on port `3100` by default. Configure deployment-specific values through environment variables; do not commit `.env` or provider credentials.

## Agent provider environment variables

Examples supported by the current provider registry include:

```env
# OpenAI-compatible
OPENAI_BASE_URL=https://example.com/v1
OPENAI_API_KEY=...
OPENAI_MODEL=...
OPENAI_API_PROTOCOL=responses

# Anthropic-compatible
ANTHROPIC_BASE_URL=https://example.com/v1
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=...
```

Codex and Claude Code use their CLI authentication flows instead of storing subscription credentials in the repository. For Codex installation, headless device auth, systemd PATH configuration, and E2E checks, see [`docs/CODEX.md`](docs/CODEX.md).

## Repository structure

```text
apps/desktop/              Browser/Electron UI inherited from Palot and extended for EIGENT
apps/server/               Hono/Bun server, workspace/process/terminal/agent APIs
packages/agent-core/       Shared agent interfaces and normalized events
packages/agent-codex/      Codex CLI adapter
packages/agent-claude/     Claude Code adapter
packages/agent-openai/     OpenAI-compatible API adapter
packages/agent-anthropic/  Anthropic-compatible API adapter
packages/ui/               Shared UI components
```

## Security note

EIGENT is intended as a personal, self-hosted development environment. Some agent modes deliberately support highly permissive execution. Do not expose an unsecured deployment directly to the public Internet. Authentication, network boundaries, process isolation, secret handling, and deployment hardening must be completed before relying on it in an untrusted environment.

## Upstream

EIGENT currently builds on [Palot](https://github.com/ItsWendell/palot) and retains the upstream license and notices. The UI and substantial inherited functionality originate from Palot; EIGENT-specific work is focused on the browser-first/self-hosted workspace, terminal/process APIs, and multi-agent provider abstraction.

## License

See [LICENSE](LICENSE).
