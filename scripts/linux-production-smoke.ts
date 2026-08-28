import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

if (process.platform !== "linux") {
	console.log("linux-production-smoke: skipped (Linux only)")
	process.exit(0)
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

function run(command: string[], cwd?: string) {
	const result = Bun.spawnSync({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" })
	if (result.exitCode !== 0) {
		throw new Error(
			`${command.join(" ")} failed (${result.exitCode})\n${result.stdout.toString()}\n${result.stderr.toString()}`,
		)
	}
	return result.stdout.toString().trim()
}

async function waitForHttp(url: string, timeoutMs = 15_000): Promise<Response> {
	const startedAt = Date.now()
	let lastError: unknown
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
			if (response.ok) return response
			lastError = new Error(`HTTP ${response.status}`)
		} catch (error) {
			lastError = error
		}
		await Bun.sleep(150)
	}
	throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`)
}

async function jsonRequest<T>(
	url: string,
	init?: RequestInit,
): Promise<{ response: Response; body: T }> {
	const response = await fetch(url, init)
	const body = (await response.json()) as T
	return { response, body }
}

function occurrences(value: string, marker: string): number {
	return value.split(marker).length - 1
}

async function ptySmoke(url: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = ""
		let exitSent = false
		const marker = "EIGENT_PTY_SERVER_OUTPUT"
		const doneMarker = "EIGENT_PTY_SERVER_DONE"
		const timer = setTimeout(() => reject(new Error(`PTY websocket timed out: ${output}`)), 8_000)
		const ws = new WebSocket(url)
		ws.addEventListener("open", () => {
			ws.send(JSON.stringify({ type: "resize", cols: 92, rows: 21 }))
			ws.send(
				JSON.stringify({
					type: "input",
					data: `echo ${marker}; stty size > .eigent-pty-server-size; echo ${doneMarker}\r`,
				}),
			)
		})
		ws.addEventListener("message", (event) => {
			output += typeof event.data === "string" ? event.data : String(event.data)
			if (!exitSent && occurrences(output, marker) >= 2 && occurrences(output, doneMarker) >= 2) {
				exitSent = true
				ws.send(JSON.stringify({ type: "input", data: "exit\r" }))
			}
		})
		ws.addEventListener("error", () => {
			clearTimeout(timer)
			reject(new Error(`PTY websocket failed: ${output}`))
		})
		ws.addEventListener("close", () => {
			clearTimeout(timer)
			resolve(output)
		})
	})
}

const base = await mkdtemp(path.join(os.tmpdir(), "eigent-linux-smoke-"))
const workspaceRoot = path.join(base, "workspaces")
const project = path.join(workspaceRoot, "project")
const outside = path.join(base, "outside")
const dataDir = path.join(base, "data")
await Promise.all([
	mkdir(project, { recursive: true }),
	mkdir(outside, { recursive: true }),
	mkdir(dataDir, { recursive: true }),
])
await writeFile(path.join(outside, "secret.txt"), "outside-secret")
await symlink(outside, path.join(project, "escape"), "dir")

run(["git", "init", "-b", "main"], project)
run(["git", "config", "user.email", "eigent-smoke@example.invalid"], project)
run(["git", "config", "user.name", "EIGENT Smoke"], project)
await writeFile(path.join(project, "README.md"), "# smoke\n")
run(["git", "add", "README.md"], project)
run(["git", "commit", "-m", "smoke"], project)

const port = 32_000 + Math.floor(Math.random() * 5_000)
const host = `127.0.0.1:${port}`
const httpBase = `http://${host}`
const server = Bun.spawn({
	cmd: [process.execPath, "run", "apps/server/dist/index.js"],
	cwd: process.cwd(),
	env: {
		...process.env,
		HOST: "127.0.0.1",
		PORT: String(port),
		EIGENT_DATA_DIR: dataDir,
		EIGENT_STATE_DB: ":memory:",
		EIGENT_DESKTOP_ENABLED: "false",
		EIGENT_WORKSPACE_ROOTS: workspaceRoot,
		EIGENT_ALLOWED_HOSTS: host,
		EIGENT_ALLOWED_ORIGINS: httpBase,
		EIGENT_MUTATION_RATE_LIMIT_PER_MINUTE: "600",
		EIGENT_BROWSER_STARTUP_TIMEOUT_MS: "1000",
	},
	stdout: "inherit",
	stderr: "inherit",
})

try {
	await waitForHttp(`${httpBase}/health/live`)

	const staticResponse = await fetch(`${httpBase}/`)
	assert(staticResponse.ok, `static PWA returned ${staticResponse.status}`)
	assert((await staticResponse.text()).toLowerCase().includes("<html"), "static PWA index missing")

	const ready = await jsonRequest<{ components?: Record<string, unknown> }>(
		`${httpBase}/health/ready`,
	)
	assert(ready.response.ok && ready.body.components, "readiness endpoint is missing components")
	for (const component of ["agents", "browser", "desktop", "processes"]) {
		assert(component in ready.body.components, `readiness missing ${component}`)
	}

	const writeResult = await jsonRequest<{ path?: string; error?: string }>(
		`${httpBase}/api/workspace/write`,
		{
			method: "PUT",
			headers: { "content-type": "application/json", origin: httpBase },
			body: JSON.stringify({ root: project, path: "src/linux.txt", content: "linux workspace ok" }),
		},
	)
	assert(writeResult.response.ok, `workspace write failed: ${JSON.stringify(writeResult.body)}`)

	const readQuery = new URLSearchParams({ root: project, path: "src/linux.txt" })
	const readResult = await jsonRequest<{ content?: string }>(
		`${httpBase}/api/workspace/read?${readQuery}`,
	)
	assert(
		readResult.response.ok && readResult.body.content === "linux workspace ok",
		"workspace read failed",
	)

	const escapeQuery = new URLSearchParams({ root: project, path: "escape/secret.txt" })
	const escapeResponse = await fetch(`${httpBase}/api/workspace/read?${escapeQuery}`)
	assert(
		escapeResponse.status === 400,
		`symlink escape should be rejected, got ${escapeResponse.status}`,
	)

	const gitQuery = new URLSearchParams({ directory: project })
	const gitStatus = await jsonRequest<{ isClean?: boolean }>(
		`${httpBase}/api/git/status?${gitQuery}`,
	)
	assert(gitStatus.response.ok, `Git API failed with ${gitStatus.response.status}`)

	const processStart = await jsonRequest<{ id?: string; error?: string }>(
		`${httpBase}/api/processes`,
		{
			method: "POST",
			headers: { "content-type": "application/json", origin: httpBase },
			body: JSON.stringify({ command: "printf EIGENT_PROCESS_SMOKE", cwd: project }),
		},
	)
	assert(processStart.response.status === 201 && processStart.body.id, "process start failed")
	let processOutput = ""
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const current = await jsonRequest<{ state?: string; output?: string }>(
			`${httpBase}/api/processes/${processStart.body.id}`,
		)
		processOutput = current.body.output ?? ""
		if (current.body.state && current.body.state !== "running") break
		await Bun.sleep(100)
	}
	assert(processOutput.includes("EIGENT_PROCESS_SMOKE"), `process output missing: ${processOutput}`)

	const ptyOutput = await ptySmoke(
		`ws://${host}/api/terminal/ws?${new URLSearchParams({ cwd: project }).toString()}`,
	)
	assert(
		occurrences(ptyOutput, "EIGENT_PTY_SERVER_OUTPUT") >= 2,
		`PTY output missing executed marker: ${ptyOutput}`,
	)
	const ptySize = (await readFile(path.join(project, ".eigent-pty-server-size"), "utf8")).trim()
	assert(/^21\s+92$/.test(ptySize), `PTY resize did not apply: ${ptySize}`)

	const agentHealth = await fetch(`${httpBase}/health/agents`)
	assert([200, 503].includes(agentHealth.status), `agent health returned ${agentHealth.status}`)
	const browserHealth = await fetch(`${httpBase}/health/browser`)
	assert(
		[200, 503].includes(browserHealth.status),
		`browser health returned ${browserHealth.status}`,
	)
	const processHealth = await fetch(`${httpBase}/health/processes`)
	assert(processHealth.ok, `process health returned ${processHealth.status}`)

	console.log("linux-production-smoke: PASS")
} finally {
	server.kill()
	await server.exited.catch(() => undefined)
	await rm(base, { recursive: true, force: true })
}
