/** OpenAI Codex CLI driver for EIGENT. */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import type {
	AgentDriver,
	AgentEvent,
	AgentModel,
	AgentSession,
	AgentSessionSnapshot,
	AgentStatus,
	StartSessionOptions,
} from "@eigent/agent-core"

const CLI_DEFAULT_MODEL = "__default__"

interface CodexDriverOptions {
	executable?: string
	models?: string[]
}

interface CodexSession extends AgentSession {
	providerSessionId?: string
	yolo: boolean
	systemPrompt?: string
}

function resolveExecutable(executable: string): string | null {
	return (
		Bun.which(executable) ??
		(path.isAbsolute(executable) && existsSync(executable) ? executable : null)
	)
}

function executableEnvironment(executable: string): NodeJS.ProcessEnv | undefined {
	if (!path.isAbsolute(executable)) return undefined
	const executableDir = path.dirname(executable)
	return {
		...process.env,
		PATH: [executableDir, process.env.PATH].filter(Boolean).join(path.delimiter),
	}
}

interface CodexJsonEvent {
	type?: string
	thread_id?: string
	message?: string
	error?: { message?: string } | string
	item?: {
		id?: string
		type?: string
		text?: string
		command?: string
		status?: string
		aggregated_output?: string
		server?: string
		tool?: string
		arguments?: unknown
		result?: unknown
	}
}

async function terminateProcessTree(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
	// On Windows, npm-installed CLIs are commonly launched through a shim. Killing only
	// the shim leaves the real Node/CLI process (and its tool subprocesses) running.
	if (process.platform === "win32") {
		try {
			const killer = Bun.spawn({
				cmd: ["taskkill", "/PID", String(proc.pid), "/T", "/F"],
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			})
			await killer.exited
		} catch {
			// Fall through to Bun's direct process kill below.
		}
	}
	try {
		proc.kill()
	} catch {
		// The process may already have exited after taskkill.
	}
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let buffer = ""
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		buffer += decoder.decode(value, { stream: true })
		const parts = buffer.split(/\r?\n/)
		buffer = parts.pop() ?? ""
		for (const line of parts) if (line.trim()) yield line
	}
	buffer += decoder.decode()
	if (buffer.trim()) yield buffer
}

export function codexEvent(event: CodexJsonEvent): AgentEvent[] {
	if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
		return [{ type: "message.delta", text: event.item.text }]
	}
	if (event.type === "item.completed" && event.item?.type === "reasoning" && event.item.text) {
		return [{ type: "reasoning.delta", text: event.item.text }]
	}
	if (
		event.type === "item.started" &&
		event.item?.id &&
		event.item.type &&
		!(["agent_message", "reasoning", "error"] as string[]).includes(event.item.type)
	) {
		return [
			{
				type: "tool.started",
				id: event.item.id,
				name: event.item.command ?? event.item.tool ?? event.item.type,
				input: event.item.arguments,
			},
		]
	}
	if (
		event.type === "item.completed" &&
		event.item?.id &&
		event.item.type &&
		!(["agent_message", "reasoning", "error"] as string[]).includes(event.item.type)
	) {
		const name = event.item.command ?? event.item.tool ?? event.item.type ?? "tool"
		const output = event.item.aggregated_output ?? event.item.result
		return [
			...(output !== undefined
				? [{ type: "tool.output", id: event.item.id, output } as AgentEvent]
				: []),
			{ type: "tool.completed", id: event.item.id, name },
		]
	}
	if (event.type === "error" || event.type === "turn.failed") {
		const message =
			typeof event.error === "string"
				? event.error
				: (event.error?.message ?? event.message ?? "Codex execution failed")
		return [{ type: "error", message, recoverable: true }]
	}
	return []
}

export class CodexDriver implements AgentDriver {
	readonly kind = "codex" as const
	private readonly executable: string
	private readonly models: string[]
	private readonly sessions = new Map<string, CodexSession>()
	private readonly active = new Map<string, ReturnType<typeof Bun.spawn>>()

	constructor(options: CodexDriverOptions = {}) {
		this.executable = options.executable ?? "codex"
		this.models = options.models ?? []
	}

	async startSession(options: StartSessionOptions): Promise<AgentSession> {
		const session: CodexSession = {
			id: randomUUID(),
			provider: this.kind,
			model: options.model,
			workspace: options.workspace,
			taskId: options.taskId,
			state: "starting",
			createdAt: Date.now(),
			yolo: options.yolo ?? true,
			systemPrompt: options.systemPrompt,
		}
		this.sessions.set(session.id, session)
		return { ...session }
	}

	async *sendMessage(sessionId: string, message: string): AsyncIterable<AgentEvent> {
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Unknown Codex session: ${sessionId}`)
		if (this.active.has(sessionId)) throw new Error("Codex session is already running")

		const prompt =
			session.systemPrompt && !session.providerSessionId
				? `${session.systemPrompt}\n\n${message}`
				: message
		const common = ["--json", "--skip-git-repo-check"]
		if (session.model !== CLI_DEFAULT_MODEL) common.push("-m", session.model)
		if (session.yolo) common.push("--dangerously-bypass-approvals-and-sandbox")
		const executable = resolveExecutable(this.executable) ?? this.executable
		const args = session.providerSessionId
			? [executable, "exec", "resume", ...common, session.providerSessionId, prompt]
			: [executable, "exec", ...common, "-C", session.workspace, prompt]

		session.state = "running"
		yield { type: "state.changed", state: "running" }
		const proc = Bun.spawn({
			cmd: args,
			cwd: session.workspace,
			env: executableEnvironment(executable),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		})
		this.active.set(sessionId, proc)
		let sawError = false
		const seenErrors = new Set<string>()

		try {
			for await (const line of lines(proc.stdout as ReadableStream<Uint8Array>)) {
				let parsed: CodexJsonEvent
				try {
					parsed = JSON.parse(line) as CodexJsonEvent
				} catch {
					continue
				}
				if (parsed.type === "thread.started" && parsed.thread_id) {
					session.providerSessionId = parsed.thread_id
				}
				for (const event of codexEvent(parsed)) {
					if (event.type === "error") {
						if (seenErrors.has(event.message)) continue
						seenErrors.add(event.message)
						sawError = true
					}
					yield event
				}
			}
			const code = await proc.exited
			if (code === 0) {
				session.state = "completed"
				yield { type: "state.changed", state: "completed" }
			} else if ((session.state as string) !== "interrupted") {
				const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text()
				session.state = "failed"
				if (!sawError) {
					yield {
						type: "error",
						message: stderr.trim() || `Codex exited with ${code}`,
						recoverable: true,
					}
				}
				yield { type: "state.changed", state: "failed" }
			}
		} finally {
			this.active.delete(sessionId)
		}
	}

	async interrupt(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId)
		const proc = this.active.get(sessionId)
		// Publish the interrupted state before terminating the process so any buffered
		// provider events can be discarded by the registry.
		if (session) session.state = "interrupted"
		if (proc) await terminateProcessTree(proc)
	}

	async resume(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Unknown Codex session: ${sessionId}`)
		if (session.state === "interrupted" || session.state === "failed") session.state = "running"
	}

	snapshotSession(sessionId: string): AgentSessionSnapshot | null {
		const session = this.sessions.get(sessionId)
		if (!session) return null
		const { providerSessionId, yolo, systemPrompt, ...sessionInfo } = session
		return {
			session: { ...sessionInfo },
			driverState: { providerSessionId, yolo, systemPrompt },
		}
	}

	restoreSession(snapshot: AgentSessionSnapshot): void {
		const state = (snapshot.driverState ?? {}) as {
			providerSessionId?: string
			yolo?: boolean
			systemPrompt?: string
		}
		this.sessions.set(snapshot.session.id, {
			...snapshot.session,
			providerSessionId: state.providerSessionId,
			yolo: state.yolo ?? true,
			systemPrompt: state.systemPrompt,
		})
	}

	async getModels(): Promise<AgentModel[]> {
		const ids = this.models.length ? this.models : [CLI_DEFAULT_MODEL]
		return ids.map((id) => ({
			id,
			name: id === CLI_DEFAULT_MODEL ? "CLI default" : id,
			provider: this.kind,
			reasoning: true,
			toolCalling: true,
		}))
	}

	async getStatus(): Promise<AgentStatus> {
		const executable = resolveExecutable(this.executable)
		if (!executable)
			return { available: false, authenticated: false, detail: "Codex CLI is not installed" }
		try {
			const proc = Bun.spawn({
				cmd: [executable, "login", "status"],
				env: executableEnvironment(executable),
				stdout: "pipe",
				stderr: "pipe",
			})
			const [code, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
				new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			])
			const detail = `${stdout}\n${stderr}`.trim()
			return { available: true, authenticated: code === 0, detail }
		} catch (err) {
			return {
				available: true,
				authenticated: false,
				detail: err instanceof Error ? err.message : String(err),
			}
		}
	}

	getDeviceAuthCommand(): string[] {
		return [this.executable, "login", "--device-auth"]
	}
}
