/** Interactive provider-auth command manager. Output is polled by the web UI. */
import { randomUUID } from "node:crypto"

export interface ProviderAuthTask {
	id: string
	provider: "codex" | "claude"
	state: "running" | "completed" | "failed" | "cancelled"
	output: string
	exitCode: number | null
	startedAt: number
	endedAt: number | null
}

interface InternalTask extends ProviderAuthTask {
	process: ReturnType<typeof Bun.spawn> | null
}

const tasks = new Map<string, InternalTask>()
const MAX_OUTPUT = 64 * 1024

function append(task: InternalTask, chunk: string) {
	task.output += chunk
	if (task.output.length > MAX_OUTPUT) task.output = task.output.slice(-MAX_OUTPUT)
}

async function pump(task: InternalTask, stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		append(task, decoder.decode(value, { stream: true }))
	}
	append(task, decoder.decode())
}

function snapshot(task: InternalTask): ProviderAuthTask {
	const { process: _process, ...publicTask } = task
	return { ...publicTask }
}

export function startProviderAuth(provider: "codex" | "claude"): ProviderAuthTask {
	const executable = provider === "codex" ? Bun.which("codex") : Bun.which("claude")
	if (!executable)
		throw new Error(`${provider === "codex" ? "Codex CLI" : "Claude Code"} is not installed`)
	const cmd =
		provider === "codex" ? [executable, "login", "--device-auth"] : [executable, "auth", "login"]
	const task: InternalTask = {
		id: randomUUID(),
		provider,
		state: "running",
		output: "",
		exitCode: null,
		startedAt: Date.now(),
		endedAt: null,
		process: null,
	}
	tasks.set(task.id, task)

	const child = Bun.spawn({ cmd, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
	task.process = child
	void pump(task, child.stdout as ReadableStream<Uint8Array>)
	void pump(task, child.stderr as ReadableStream<Uint8Array>)
	void child.exited.then((code) => {
		task.exitCode = code
		task.state = task.state === "cancelled" ? "cancelled" : code === 0 ? "completed" : "failed"
		task.endedAt = Date.now()
		task.process = null
	})
	return snapshot(task)
}

export function getProviderAuth(id: string): ProviderAuthTask | null {
	const task = tasks.get(id)
	return task ? snapshot(task) : null
}

export function cancelProviderAuth(id: string): boolean {
	const task = tasks.get(id)
	if (!task?.process || task.state !== "running") return false
	task.state = "cancelled"
	task.process.kill()
	return true
}
