# Codex CLI on headless Linux

EIGENT's Codex provider runs the official Codex CLI as the same operating-system user that runs the EIGENT server. Subscription credentials stay in that user's Codex configuration and are never copied into the repository or browser bundle.

## Supported baseline

The EIGENT driver and its real end-to-end checks target Codex CLI `0.150.1`.

On Ubuntu, install a current Node.js release for the EIGENT service account and then install Codex:

```bash
npm install -g @openai/codex@0.150.1
codex --version
```

For NVM or another per-user Node installation, run these commands as the same Unix account that will start EIGENT.

## Headless ChatGPT login

A server without a desktop can authenticate with Codex device auth:

```bash
codex login --device-auth
```

The command prints a browser URL and a short-lived device code. Open the URL on another device, enter the code, and finish the ChatGPT sign-in. Back on the server, verify the persisted login:

```bash
codex login status
```

A successful subscription login reports `Logged in using ChatGPT`. The credentials belong to the service user's Codex home (normally `~/.codex`), so do not run the login as `root` if EIGENT runs as another account.

EIGENT also exposes the same device-auth flow through `POST /api/agents/providers/codex/auth`. Poll the returned task with `GET /api/agents/auth/:id`; its output contains the URL/code needed to finish login from another browser.

## systemd and minimal PATH environments

A non-interactive systemd service often does not load NVM or shell profile files. If `codex` is not on the service PATH, point EIGENT at the absolute executable:

```env
EIGENT_CODEX_EXECUTABLE=/home/eigent/.nvm/versions/node/v22.23.2/bin/codex
```

The override is used both for provider status/execution and for the web-triggered device-auth command. This avoids a state where interactive shell checks work but EIGENT reports that Codex is missing.

If desired, expose only explicit model IDs:

```env
EIGENT_CODEX_MODELS=model-id-1,model-id-2
```

When `EIGENT_CODEX_MODELS` is unset, EIGENT exposes `__default__`, which delegates model selection to the installed Codex CLI.

## EIGENT verification

After starting the server, verify discovery and authentication:

```bash
curl -s http://127.0.0.1:3100/api/agents/providers
```

The Codex entry should have `available: true` and `authenticated: true`. Start a session using the CLI default model:

```bash
curl -s -X POST http://127.0.0.1:3100/api/agents/sessions \
  -H 'content-type: application/json' \
  -d '{"provider":"codex","workspace":"/path/to/workspace","model":"__default__","yolo":true}'
```

Send a message to the returned session ID through `POST /api/agents/sessions/:id/messages`. That endpoint streams normalized SSE agent events. A normal completed run includes the requested/running events, message/reasoning/tool events as produced by Codex, and a terminal completion event.

For interruption/recovery checks, call `POST /api/agents/sessions/:id/interrupt`, then inspect `GET /api/agents/sessions/:id/recovery`. Resume with `POST /api/agents/sessions/:id/resume` and send the next message to the same session. EIGENT persists the Codex provider thread ID so the CLI uses `codex exec resume` after reconnects.

YOLO mode is EIGENT's default for this personal deployment and maps to Codex `--dangerously-bypass-approvals-and-sandbox`. Set `"yolo": false` when creating a session if that behavior is not wanted.

## Authentication and quota failures

`codex login status` is the source of truth for provider authentication. If credentials are expired or revoked, EIGENT reports `authenticated: false`; run device auth again as the service account.

A valid login can still be unable to start a turn because of subscription usage limits. Codex emits that as a provider error/failed turn; it does not mean the stored login is invalid. Wait for the quota reset or use an available supported model/credit allocation, then retry the same EIGENT session.

## Validation record

- Windows: Codex CLI `0.150.1` + ChatGPT subscription completed a real `/api/agents` task, streaming, provider-thread resume, YOLO execution, and interrupt/recovery checks.
- Linux: Ubuntu 26.04 x86_64 with native Node.js 22 and native Codex CLI `0.150.1` verified installation, `codex login status`, persisted ChatGPT authentication, and an isolated headless `--device-auth` challenge.
- A further Linux turn reached `thread.started` but the account was at its subscription usage limit, confirming the native CLI/auth path reached the provider; the earlier real E2E run covers successful task completion behavior.
