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
let singleServerStartPromise: Promise<OpenCodeServer> | null = null

const OPENCODE_PORT = 4101
const OPENCODE_HOSTNAME = "127.0.0.1"
let activeServerLeases = 0
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null

export function resolveOpenCodeIdleTimeoutMs(): number {
	const configured = process.env.EIGENT_OPENCODE_IDLE_TIMEOUT_MS?.trim()
	if (configured !== undefined && configured !== "") {
		const value = Number(configured)
		if (!Number.isFinite(value) || value <= 0) return 0
		return Math.min(24 * 60 * 60_000, Math.max(1_000, Math.trunc(value)))
	}
	return process.env.EIGENT_BROWSER_LOW_MEMORY === "true" ? 60_000 : 0
}

export function hasActiveOpenCodeSessions(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return true
	return Object.values(value as Record<string, unknown>).some((status) => {
		if (!status || typeof status !== "object") return true
		const type = (status as { type?: unknown }).type
		return type !== "idle"
	})
}

function clearIdleShutdownTimer(): void {
	if (!idleShutdownTimer) return
	clearTimeout(idleShutdownTimer)
	idleShutdownTimer = null
}

async function managedServerHasActiveSessions(server: OpenCodeServer): Promise<boolean> {
	try {
		const response = await fetch(`${server.url}/session/status`, {
			signal: AbortSignal.timeout(2_000),
		})
		if (!response.ok) return true
		return hasActiveOpenCodeSessions(await response.json())
	} catch {
		// A failed status probe should never terminate a potentially busy agent.
		return true
	}
}

function scheduleIdleShutdown(): void {
	clearIdleShutdownTimer()
	const timeoutMs = resolveOpenCodeIdleTimeoutMs()
	if (timeoutMs <= 0 || activeServerLeases > 0 || !singleServer?.process) return

	idleShutdownTimer = setTimeout(() => {
		idleShutdownTimer = null
		void (async () => {
			const current = singleServer?.server
			if (!current || activeServerLeases > 0 || !singleServer?.process) return
			const hasActiveSessions = await managedServerHasActiveSessions(current)

			// A new proxy request may acquire a lease while the status probe is in flight.
			// Never stop a replaced/restarted process or a server that became active meanwhile.
			if (activeServerLeases > 0 || singleServer?.server !== current || !singleServer.process)
				return
			if (hasActiveSessions) {
				scheduleIdleShutdown()
				return
			}
			console.log(`Stopping idle OpenCode server after ${timeoutMs}ms without clients`)
			stopServer()
		})()
	}, timeoutMs)
	idleShutdownTimer.unref?.()
}

/** Hold the managed OpenCode process while a proxied client request/stream is active. */
export function retainServerActivity(): () => void {
	activeServerLeases++
	clearIdleShutdownTimer()
	let released = false
	return () => {
		if (released) return
		released = true
		activeServerLeases = Math.max(0, activeServerLeases - 1)
		if (activeServerLeases === 0) scheduleIdleShutdown()
	}
}

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
async function startSingleServer(): Promise<OpenCodeServer> {
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
			clearIdleShutdownTimer()
		}
	})

	// Wait for the server to be ready. Do not leave a failed startup resident.
	try {
		await waitForReady(url, Number(process.env.EIGENT_OPENCODE_STARTUP_TIMEOUT_MS ?? "15000"))
	} catch (error) {
		if (singleServer?.process === proc) singleServer = null
		proc.kill()
		throw error
	}

	console.log(`OpenCode server started at ${url} (pid ${proc.pid})`)
	if (activeServerLeases === 0) scheduleIdleShutdown()
	return server
}

export async function ensureSingleServer(): Promise<OpenCodeServer> {
	if (singleServer) return singleServer.server
	if (singleServerStartPromise) return singleServerStartPromise

	const startPromise = startSingleServer()
	singleServerStartPromise = startPromise
	try {
		return await startPromise
	} finally {
		if (singleServerStartPromise === startPromise) singleServerStartPromise = null
	}
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
	clearIdleShutdownTimer()
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
