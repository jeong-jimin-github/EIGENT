import fs from "node:fs"
import { type ChildProcess, spawn, type SpawnOptionsWithoutStdio } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"

/**
 * Resolve the real OpenCode executable instead of relying on npm's .cmd shim.
 * Node/Electron cannot spawn .cmd files directly on Windows without a shell,
 * and using a shell would make password-bearing CLI arguments unsafe.
 */
export function resolveOpenCodeExecutable(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform !== "win32") return "opencode"

	const candidates = new Set<string>()
	const home = env.USERPROFILE || env.HOME || homedir()
	if (home) {
		candidates.add(path.join(home, ".opencode", "bin", "opencode.exe"))
	}

	if (env.APPDATA) {
		candidates.add(path.join(env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe"))
	}

	for (const entry of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		candidates.add(path.join(entry, "opencode.exe"))
		// npm global shims live one directory above node_modules/opencode-ai.
		candidates.add(path.join(entry, "node_modules", "opencode-ai", "bin", "opencode.exe"))
	}

	for (const candidate of candidates) {
		try {
			if (fs.statSync(candidate).isFile()) return candidate
		} catch {
			// Try the next candidate.
		}
	}

	// Native Windows installs may expose opencode.exe directly through PATH.
	return "opencode.exe"
}

export function createOpenCodeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const home = env.USERPROFILE || env.HOME || homedir()
	const binDir = path.join(home, ".opencode", "bin")
	return {
		...env,
		PATH: [binDir, env.PATH].filter(Boolean).join(path.delimiter),
	}
}

export function spawnOpenCode(
	args: string[],
	options: Omit<SpawnOptionsWithoutStdio, "env"> & { env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
	const env = createOpenCodeEnv(options.env ?? process.env)
	return spawn(resolveOpenCodeExecutable(env), args, { ...options, env })
}

export async function runOpenCode(
	args: string[],
	options: Omit<SpawnOptionsWithoutStdio, "env"> & { env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		const proc = spawnOpenCode(args, { ...options, stdio: "pipe" })
		let stdout = ""
		let stderr = ""
		proc.stdout?.setEncoding("utf8")
		proc.stderr?.setEncoding("utf8")
		proc.stdout?.on("data", (chunk: string) => {
			stdout += chunk
		})
		proc.stderr?.on("data", (chunk: string) => {
			stderr += chunk
		})
		proc.once("error", reject)
		proc.once("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr })
				return
			}
			reject(new Error(`OpenCode exited with code ${code}: ${stderr.trim() || stdout.trim()}`))
		})
	})
}
