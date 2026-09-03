# Secure single-user deployment (Ubuntu)

EIGENT deliberately keeps its authenticated agent execution permissive (YOLO). The security boundary for an Internet-facing installation must therefore be **outside the agent session**: TLS + single-user authentication at the reverse proxy, strict host/origin checks in EIGENT, and an explicit workspace/process filesystem boundary.

## Supported baseline

The CI production lane targets Ubuntu on GitHub Actions with Bun `1.3.8` and Node.js `22`. EIGENT runs under Bun, but Linux PTY sessions use a small Node.js bridge because `node-pty` is a native Node addon and Bun 1.3.8 can terminate the spawned PTY shell before command output is delivered. On a clean Ubuntu host install Node.js 22 plus the native build prerequisites used by `node-pty` and Git:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git build-essential python3 pkg-config nginx apache2-utils
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
curl -fsSL https://bun.sh/install | bash -s -- bun-v1.3.8
sudo install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun
```

For the managed graphical desktop, also install the packages documented in [`DESKTOP.md`](DESKTOP.md). They are not required for a headless server with `EIGENT_DESKTOP_ENABLED=false`.

Build and validate the production web/server bundle:

```bash
node --version   # v22.x
bun --version    # 1.3.8
bun install --frozen-lockfile
bun run check-types
bun run build:web
bun test apps/server/src/services/security-policy.test.ts \
  apps/server/src/services/workspace-service.test.ts \
  apps/server/src/services/terminal-session.linux.test.ts
bun run scripts/linux-production-smoke.ts
```

The Linux smoke test starts the built server and verifies the static PWA, workspace read/write, symlink rejection, Git API, process execution, real `node-pty` WebSocket input/resize/output/exit, and agent/browser/process health endpoints.

## Service account and filesystem

A reasonable single-user layout is:

```bash
sudo useradd --system --home-dir /var/lib/eigent/home --create-home --shell /usr/sbin/nologin eigent
sudo mkdir -p /opt/eigent /var/lib/eigent /srv/eigent-workspaces /etc/eigent
sudo chown -R eigent:eigent /opt/eigent /var/lib/eigent /srv/eigent-workspaces
```

Deploy the repository/build under `/opt/eigent`. Keep project workspaces under `/srv/eigent-workspaces`; do not point the production service at `/`, `/home`, or another broad filesystem root.

Create `/etc/eigent/eigent.env` with mode `0600`. Example:

```dotenv
HOST=127.0.0.1
PORT=3100
EIGENT_HTTP_IDLE_TIMEOUT_SECONDS=120
EIGENT_DATA_DIR=/var/lib/eigent
EIGENT_STATE_DB=/var/lib/eigent/eigent.db

# The public hostname is preserved by nginx. Keep localhost for direct health checks.
EIGENT_ALLOWED_HOSTS=eigent.example.com,127.0.0.1:3100
EIGENT_ALLOWED_ORIGINS=https://eigent.example.com
EIGENT_WORKSPACE_ROOTS=/srv/eigent-workspaces

# Application-side defense in depth; nginx should also cap request bodies.
EIGENT_MAX_REQUEST_BYTES=16777216
EIGENT_MAX_UPLOAD_BYTES=16777216
EIGENT_MUTATION_RATE_LIMIT_PER_MINUTE=240

# Optional for a headless deployment.
EIGENT_DESKTOP_ENABLED=false

# Recommended on memory-constrained hosts. The managed OpenCode child is stopped
# after this many milliseconds without proxied clients, but only when every
# reported OpenCode session is idle. Set 0 to disable this lifecycle policy.
EIGENT_OPENCODE_IDLE_TIMEOUT_MS=60000
# The managed Chrome + Playwright worker use the same low-memory lifecycle idea.
# Browser Live snapshots and browser actions hold an activity lease, so active work
# is never interrupted. Set 0 to keep the browser resident after first use.
EIGENT_BROWSER_IDLE_TIMEOUT_MS=60000
# Managed Xvfb/openbox/x11vnc are also reclaimed after inactivity on low-memory hosts.
# Active VNC viewers and Computer actions hold an activity lease. Set 0 to disable.
EIGENT_DESKTOP_IDLE_TIMEOUT_MS=60000
# Avoid competing CLI/model probes during OpenCode cold starts on small VMs.
EIGENT_PROVIDER_PREWARM=false

# Provider credentials belong here, never in VITE_* variables or the client bundle.
# OPENAI_API_KEY=...
# ANTHROPIC_API_KEY=...
```

```bash
sudo chown eigent:eigent /etc/eigent/eigent.env
sudo chmod 600 /etc/eigent/eigent.env
```

`EIGENT_WORKSPACE_ROOTS` is a comma-separated allowlist. When it is set, workspace, terminal, process, Git, task/session workspace, recovery, and browser-upload paths are constrained to those roots. Existing filesystem prefixes are resolved through real paths, so a symlink cannot be used to escape a permitted workspace. Leaving it unset preserves the local-development YOLO behavior.

`EIGENT_ALLOWED_HOSTS` and `EIGENT_ALLOWED_ORIGINS` are also comma-separated exact allowlists. They protect ordinary API requests and WebSocket upgrades. Leaving `EIGENT_ALLOWED_HOSTS` unset keeps local development compatible, so **set it on every public deployment**.

## systemd

`/etc/systemd/system/eigent.service`:

```ini
[Unit]
Description=EIGENT personal coding agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=eigent
Group=eigent
WorkingDirectory=/opt/eigent
Environment=HOME=/var/lib/eigent/home
Environment=PATH=/var/lib/eigent/home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=/etc/eigent/eigent.env
ExecStart=/usr/local/bin/bun run apps/server/dist/index.js
Restart=on-failure
RestartSec=3
UMask=0077

# Optional OS-level containment that still leaves the authenticated agent YOLO
# inside its explicit writable data/workspace locations.
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/eigent /srv/eigent-workspaces

[Install]
WantedBy=multi-user.target
```

Authenticate CLI providers as the `eigent` service user with `HOME=/var/lib/eigent/home`, so their writable auth/session state remains under the service data directory even with `ProtectHome=true`. The example PATH includes the service user's `~/.local/bin`, which is also EIGENT's default automatic-install target on Linux. If you install provider executables somewhere else, keep that directory on the unit PATH or use an explicit executable override. For stronger isolation, run EIGENT in a VM/container whose only host bind mounts are `/var/lib/eigent` and `/srv/eigent-workspaces`; this preserves confirmation-free execution inside that sandbox without granting the agent the host filesystem.

Enable it only after the production build succeeds:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now eigent
curl -H 'Host: 127.0.0.1:3100' http://127.0.0.1:3100/health/live
```

## HTTPS + single-user authentication with nginx

Do not expose port `3100` to the Internet. Bind EIGENT to loopback and put authentication in front of it.

Create a password file:

```bash
sudo htpasswd -c /etc/nginx/eigent.htpasswd your-user
```

Example nginx server (replace certificate paths/domain):

```nginx
server {
    listen 443 ssl http2;
    server_name eigent.example.com;

    ssl_certificate     /etc/letsencrypt/live/eigent.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/eigent.example.com/privkey.pem;

    auth_basic "EIGENT";
    auth_basic_user_file /etc/nginx/eigent.htpasswd;
    client_max_body_size 16m;

    # Vite filenames under /assets/ are content-hashed. Serving them directly
    # avoids a Bun proxy hop and lets browsers cache them for a full year.
    location ^~ /assets/ {
        alias /opt/eigent/apps/desktop/dist-web/assets/;
        expires 1y;
        add_header Cache-Control "public, immutable" always;
        gzip on;
        gzip_vary on;
        gzip_min_length 1024;
        gzip_comp_level 5;
        gzip_types application/javascript application/json text/css image/svg+xml;
    }

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

Use your normal ACME/Certbot workflow for TLS. Port 80 should redirect to HTTPS, not proxy the application directly.

### Cloudflare Access alternative

Instead of nginx Basic Auth, place the hostname behind Cloudflare Access and create a policy that permits only your identity. Keep EIGENT bound to loopback/private origin networking, keep `EIGENT_ALLOWED_HOSTS`/`EIGENT_ALLOWED_ORIGINS` set, and ensure the origin cannot be reached by bypassing Access. Access authentication is the perimeter; EIGENT remains YOLO after that perimeter has authenticated you.

## Health checks

- `GET /health/live` — process liveness.
- `GET /health/ready` — aggregate agent/browser/desktop/process component snapshot.
- `GET /health/agents` — provider status probe (`200` or `503`).
- `GET /health/browser` — browser connectivity (`200` or `503`).
- `GET /health/processes` — managed process manager status.

A disabled/unavailable browser or desktop is reported in readiness without making the core server liveness endpoint fail.

## Secret and logging rules

- Put provider API keys only in the server environment/`EnvironmentFile`; never prefix secrets with `VITE_` and never copy them into `apps/desktop` source or static assets.
- Keep `/etc/eigent/eigent.env`, the browser profile, cookies, OAuth state, and EIGENT data directory readable only by the service user.
- Do not print `process.env`, authorization headers, cookies, provider tokens, or full request bodies in logs.
- The browser profile intentionally persists cookies and credentials across sessions. Treat `/var/lib/eigent/browser/profile` as a secret-bearing directory.
- Reverse-proxy access logs should not include query strings if you place sensitive data in them; preferably do not put secrets in URLs at all.

## Production security checklist

Before making the hostname reachable from the Internet, verify all of the following:

- [ ] EIGENT binds to `127.0.0.1` or a private interface, not a directly exposed public socket.
- [ ] HTTPS is mandatory and a single-user auth layer (nginx auth or Cloudflare Access) is enforced before EIGENT.
- [ ] `EIGENT_ALLOWED_HOSTS` and `EIGENT_ALLOWED_ORIGINS` contain only the intended public/local values.
- [ ] `EIGENT_WORKSPACE_ROOTS` is set to a narrow project root.
- [ ] Request/upload limits and a nonzero mutation rate limit are configured.
- [ ] Provider secrets are server-only and secret-bearing files/directories are mode `0600`/`0700` as appropriate.
- [ ] The service/VM/container can write only the EIGENT data and workspace directories it actually needs.
- [ ] `bun run check-types`, `bun run build:web`, Linux integration tests, and `scripts/linux-production-smoke.ts` pass on the deployment revision.
- [ ] `/health/live` works from the reverse proxy/monitoring path and WebSocket terminal connections work through the proxy.
