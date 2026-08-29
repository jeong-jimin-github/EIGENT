import fs from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

// ============================================================
// Types
// ============================================================

export interface OpenCodeServer {
	url: string
	pid: number | null
	managed: boolean
}

// ============================================================
// State — single server
// ============================================================

let singleServer: {
	server: OpenCodeServer
	process: ReturnType<typeof Bun.spawn> | null
} | null = null

const OPENCODE_PORT = 4101
const OPENCODE_HOSTNAME = "127.0.0.1"

function resolveOpenCodeExecutable(): string {
	if (process.platform !== "win32") return "opencode"

	const candidates = new Set<string>()
	const home = process.env.USERPROFILE || process.env.HOME || homedir()
	if (home) candidates.add(path.join(home, ".opencode", "bin", "opencode.exe"))
	if (process.env.APPDATA) {
		candidates.add(
			path.join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"),
		)
	}
	for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		candidates.add(path.join(entry, "opencode.exe"))
		candidates.add(path.join(entry, "node_modules", "opencode-ai", "bin", "opencode.exe"))
	}
	for (const candidate of candidates) {
		try {
			if (fs.statSync(candidate).isFile()) return candidate
		} catch {
			// Try the next candidate.
		}
	}
	return "opencode.exe"
}

function openCodeEnvironment(): Record<string, string | undefined> {
	const home = process.env.USERPROFILE || process.env.HOME || homedir()
	return {
		...process.env,
		PATH: [path.join(home, ".opencode", "bin"), process.env.PATH]
			.filter(Boolean)
			.join(path.delimiter),
	}
}

// ============================================================
// Public API
// ============================================================

/**
 * Ensures the single OpenCode server is running.
 * Starts it if not already running. Returns the server info.
 *
 * The server is started without a specific cwd — it serves ALL projects.
 * Each API request uses the `directory` query param to scope to a project.
 */
export async function ensureSingleServer(): Promise<OpenCodeServer> {
	if (singleServer) return singleServer.server

	// Check if there's already an opencode server running on our port
	const existing = await detectExistingServer()
	if (existing) {
		singleServer = { server: existing, process: null }
		return existing
	}

	// Start the real executable directly. On Windows npm installs expose a
	// .cmd shim that Bun/Node cannot safely execute without a shell.
	const proc = Bun.spawn({
		cmd: [
			resolveOpenCodeExecutable(),
			"serve",
			`--hostname=${OPENCODE_HOSTNAME}`,
			`--port=${OPENCODE_PORT}`,
		],
		cwd: homedir(), // arbitrary cwd — directory param overrides per-request
		stdout: "pipe",
		stderr: "pipe",
		env: openCodeEnvironment(),
	})

	const url = `http://${OPENCODE_HOSTNAME}:${OPENCODE_PORT}`
	const server: OpenCodeServer = {
		url,
		pid: proc.pid,
		managed: true,
	}

	singleServer = { server, process: proc }

	// Clean up on exit
	proc.exited.then(() => {
		if (singleServer?.process === proc) {
			console.log(`OpenCode server (pid ${proc.pid}) exited — will restart on next request`)
			singleServer = null
		}
	})

	// Wait for the server to be ready
	await waitForReady(url, 15_000)

	console.log(`OpenCode server started at ${url} (pid ${proc.pid})`)
	return server
}

/**
 * Gets the single server URL, or null if not running.
 */
export function getServerUrl(): string | null {
	return singleServer?.server.url ?? null
}

/**
 * Stops the single server if we manage it.
 */
export function stopServer(): boolean {
	if (!singleServer?.process) return false
	singleServer.process.kill()
	singleServer = null
	return true
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Detects an existing opencode server running on the expected port.
 */
async function detectExistingServer(): Promise<OpenCodeServer | null> {
	const url = `http://${OPENCODE_HOSTNAME}:${OPENCODE_PORT}`
	try {
		const res = await fetch(`${url}/session`, {
			signal: AbortSignal.timeout(2000),
		})
		if (res.ok) {
			return { url, pid: null, managed: false }
		}
	} catch {
		// Not running
	}
	return null
}

/**
 * Polls the session endpoint until the server responds.
 */
async function waitForReady(url: string, timeoutMs: number): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`${url}/session`, {
				signal: AbortSignal.timeout(1000),
			})
			if (res.ok) return
		} catch {
			// Not ready yet
		}
		await Bun.sleep(250)
	}
	throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`)
}
