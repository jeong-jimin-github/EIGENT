# Google Antigravity CLI provider

EIGENT supports the official Antigravity CLI (`agy`) as an `AgentDriver` provider.

## Install and authenticate

Install Antigravity CLI with Google's official installer, then run `agy` once as the same OS user that runs EIGENT and complete Google Sign-In. Antigravity stores credentials in the operating-system keyring; headless EIGENT runs reuse those cached credentials.

On remote/SSH hosts, complete the authorization URL printed by Antigravity from another browser.

## Mapping

- headless execution: `agy -p ... --output-format stream-json`
- EIGENT YOLO: `--dangerously-skip-permissions`
- resume: `--conversation <conversation_id>`
- interrupt: terminate the active `agy` process
- model discovery: a non-generating invalid-model probe, because `agy models` can remain interactive without a TTY

Set `EIGENT_ANTIGRAVITY_MODELS` to a comma-separated list to override discovery.

Set `EIGENT_ANTIGRAVITY_HOME` to an EIGENT-owned directory to isolate Antigravity settings, hooks, plugins, and local conversation files while still reusing the OS-keyring login. This is recommended for server deployments.

## Isolation note

Antigravity currently has no documented auth-profile selector. EIGENT therefore uses the same OS keyring and Antigravity user settings as the service account. Custom Antigravity hooks/plugins can affect headless runs. Use a dedicated OS account for EIGENT if strict configuration isolation is required.
