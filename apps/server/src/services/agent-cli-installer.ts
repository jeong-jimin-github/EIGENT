import { homedir } from "node:os"
import path from "node:path"
import type { AgentProviderKind } from "@eigent/agent-core"

type InstallableAgentKind = "codex" | "claude" | "antigravity"

const INSTALLABLE: InstallableAgentKind[] = ["codex", "claude", "antigravity"]
const activeInstalls = new Map<InstallableAgentKind, Promise<string>>()
const failureAt = new Map<InstallableAgentKind, number>()
const FAILURE_RETRY_MS = 5 * 60_000

function isInstallable(kind: AgentProviderKind): kind is InstallableAgentKind {
	return INSTALLABLE.includes(kind as InstallableAgentKind)
}

function installPrefix(): string {
	return process.env.EIGENT_AGENT_INSTALL_PREFIX?.trim() || path.join(homedir(), ".local")
}

function candidateBinDirs(): string[] {
	const dirs = [path.join(installPrefix(), "bin")]
	if (process.platform === "win32") {
		if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "agy", "bin"))
		if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "npm"))
	}
	return dirs
}

/** Make user-local agent installations visible to Bun.which and all spawned CLIs. */
export function ensureAgentInstallPath(): void {
	const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
	const normalized = new Set(current.map((value) => path.resolve(value).toLowerCase()))
	const additions = candidateBinDirs().filter(
		(value) => !normalized.has(path.resolve(value).toLowerCase()),
	)
	if (additions.length) process.env.PATH = [...additions, ...current].join(path.delimiter)
}

ensureAgentInstallPath()

function executableName(kind: InstallableAgentKind): string {
	if (kind === "antigravity") return "agy"
	return kind
}

function npmInstallCommand(packageName: string): string[] {
	if (process.platform === "win32") return ["npm", "install", "-g", packageName]
	return ["npm", "install", "-g", "--prefix", installPrefix(), packageName]
}

function installCommand(kind: InstallableAgentKind): string[] {
	if (kind === "codex") return npmInstallCommand("@openai/codex@latest")
	if (kind === "claude") return npmInstallCommand("@anthropic-ai/claude-code@latest")
	if (process.platform === "win32") {
		return [
			"cmd.exe",
			"/d",
			"/s",
			"/c",
			"curl -fsSL https://antigravity.google/cli/install.cmd -o %TEMP%\eigent-agy-install.cmd && call %TEMP%\eigent-agy-install.cmd --skip-path && del %TEMP%\eigent-agy-install.cmd",
		]
	}
	return [
		"/bin/bash",
		"-lc",
		"curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --skip-path",
	]
}

async function runInstaller(kind: InstallableAgentKind): Promise<string> {
	const cmd = installCommand(kind)
	console.log(`Agent CLI ${executableName(kind)} is missing; installing automatically`)
	const proc = Bun.spawn({
		cmd,
		env: process.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
	])
	if (code !== 0) {
		const detail = `${stdout}\n${stderr}`.trim().slice(-4_000)
		throw new Error(`Automatic ${kind} CLI installation failed (${code}): ${detail}`)
	}
	ensureAgentInstallPath()
	const executable = Bun.which(executableName(kind))
	if (!executable) throw new Error(`Automatic ${kind} CLI installation completed but executable was not found`)
	console.log(`Agent CLI ${kind} installed at ${executable}`)
	return executable
}

/** Ensure one provider's native CLI exists. Non-CLI providers are ignored. */
export async function ensureAgentCliInstalled(kind: AgentProviderKind): Promise<string | null> {
	if (!isInstallable(kind)) return null
	ensureAgentInstallPath()
	const existing = Bun.which(executableName(kind))
	if (existing) return existing
	if (process.env.EIGENT_AUTO_INSTALL_AGENTS === "false") return null

	const failedAt = failureAt.get(kind)
	if (failedAt && Date.now() - failedAt < FAILURE_RETRY_MS) return null

	const inFlight = activeInstalls.get(kind)
	if (inFlight) return inFlight

	const install = runInstaller(kind)
		.then((executable) => {
			failureAt.delete(kind)
			return executable
		})
		.catch((error) => {
			failureAt.set(kind, Date.now())
			throw error
		})
		.finally(() => activeInstalls.delete(kind))
	activeInstalls.set(kind, install)
	return install
}

/** Install all built-in CLI agents sequentially to avoid concurrent npm prefix mutations. */
export async function ensureAgentClisInstalled(): Promise<void> {
	for (const kind of INSTALLABLE) {
		try {
			await ensureAgentCliInstalled(kind)
		} catch (error) {
			console.warn(
				`Automatic ${kind} CLI installation failed:`,
				error instanceof Error ? error.message : error,
			)
		}
	}
}
