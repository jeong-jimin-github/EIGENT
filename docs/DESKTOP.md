# Shared Linux Desktop and Computer MCP

EIGENT can keep one persistent graphical Linux desktop alive for both the coding agent and the user. The server manages an Xvfb display, Openbox window manager, and an x11vnc server bound to localhost. The web UI connects through EIGENT's WebSocket proxy with the noVNC client, so the raw VNC port does not need to be exposed publicly.

## Install Linux dependencies

On Debian or Ubuntu:

```bash
./scripts/install-ubuntu-desktop-deps.sh
```

The managed runtime requires `Xvfb`, `openbox`, `x11vnc`, `xdotool`, `scrot`, `xclip`, and `xdpyinfo`. On Linux, the desktop runtime is enabled by default. Set `EIGENT_DESKTOP_ENABLED=false` to disable it.

The default display is `:99` at `1440x900x24`, with x11vnc listening only on `127.0.0.1:5900`. These values can be overridden with the `EIGENT_DESKTOP_*` variables documented in `.env.example`.

## Web Take Control

Open a project and select **Project Tools → Desktop**. The panel shows the same desktop used by the agent.

- **Take Control** switches the shared input owner to the user and enables noVNC keyboard/mouse input.
- While the user owns control, Computer MCP mouse, keyboard, typing, window activation, app launch, clipboard writes, and clicks are rejected by the server. Screenshots and clipboard reads remain available.
- **Return to Agent** restores Computer MCP input.
- **Upload** writes a file to the persistent shared directory (`EIGENT_DESKTOP_SHARED_DIR`).
- **Paste clipboard** sends the browser clipboard into the shared X clipboard through noVNC.

The X/VNC processes are detached from HTTP/WebSocket clients, so reconnecting the browser does not reset the desktop. The runtime also detects an already-running X display and VNC server after an EIGENT server restart.

## Computer MCP

Start the EIGENT server first, then configure an MCP client to run:

```bash
bun run --cwd apps/server computer:mcp
```

The MCP process talks back to the main EIGENT server at `http://127.0.0.1:3100` by default. Override that with `EIGENT_SERVER_URL` when necessary.

Available tools include desktop status, screenshot, mouse move/click, key combinations, text entry, visible window listing/activation, GUI application launch, and clipboard get/set. This HTTP-backed design means the MCP process and noVNC UI share the same Take Control lock instead of maintaining independent desktop state.

## Health and recovery

- `GET /api/desktop/status` — runtime, dependency, VNC, display, and control-owner state.
- `GET /api/desktop/health` — returns 200 only when X and VNC are ready.
- `POST /api/desktop/ensure` — start or reconnect to the managed desktop.
- `POST /api/desktop/restart` — restart managed child processes.

The VNC socket remains localhost-only. Internet-facing authentication, reverse-proxy hardening, and TLS are deployment concerns and should be handled together with the production deployment hardening work.
