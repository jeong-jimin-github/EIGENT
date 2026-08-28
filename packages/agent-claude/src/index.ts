/** Claude Code CLI driver for EIGENT. */
import { randomUUID } from "node:crypto"
import type {
	AgentDriver,
	AgentEvent,
	AgentModel,
	AgentSession,
	AgentSessionSnapshot,
	AgentStatus,
	StartSessionOptions,
} from "@eigent/agent-core"

interface ClaudeDriverOptions {
	executable?: string
	models?: string[]
	effort?: "low" | "medium" | "high" | "xhigh" | "max"
}

interface ClaudeSession extends AgentSession {
	yolo: boolean
	systemPrompt?: string
	started: boolean
}

export interface ClaudeStreamEvent {
	type?: string
	subtype?: string
	session_id?: string
	event?: {
		type?: string
		index?: number
		content_block?: { type?: string; id?: string; name?: string; input?: unknown }
		delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
	}
	message?: {
		error?: string
		is_api_error_message?: boolean
		content?: Array<{
			type?: string
			text?: string
			id?: string
			name?: string
			input?: unknown
			content?: unknown
		}>
	}
	result?: string
	errors?: string[]
	is_error?: boolean
	api_error_status?: number
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

export function mapClaudeEvent(event: ClaudeStreamEvent): AgentEvent[] {
	if (event.type === "stream_event" && event.event?.type === "content_block_delta") {
		if (event.event.delta?.type === "text_delta" && event.event.delta.text) {
			return [{ type: "message.delta", text: event.event.delta.text }]
		}
		if (event.event.delta?.type === "thinking_delta" && event.event.delta.thinking) {
			return [{ type: "reasoning.delta", text: event.event.delta.thinking }]
		}
	}

	if (event.type === "stream_event" && event.event?.type === "content_block_start") {
		const block = event.event.content_block
		if (block?.type === "tool_use" && block.id && block.name) {
			return [{ type: "tool.started", id: block.id, name: block.name, input: block.input }]
		}
	}

	if (event.type === "user") {
		const results: AgentEvent[] = []
		for (const block of event.message?.content ?? []) {
			if (block.type === "tool_result" && block.id) {
				results.push({ type: "tool.output", id: block.id, output: block.content })
			}
		}
		return results
	}

	if (event.type === "result" && (event.subtype !== "success" || event.is_error)) {
		return [
			{
				type: "error",
				message: event.errors?.join("\n") || event.result || "Claude Code execution failed",
				recoverable: true,
			},
		]
	}
	return []
}

export class ClaudeDriver implements AgentDriver {
	readonly kind = "claude" as const
	private readonly executable: string
	private readonly models: string[]
	private readonly effort?: ClaudeDriverOptions["effort"]
	private readonly sessions = new Map<string, ClaudeSession>()
	private readonly active = new Map<string, ReturnType<typeof Bun.spawn>>()

	constructor(options: ClaudeDriverOptions = {}) {
		this.executable = options.executable ?? "claude"
		this.models = options.models ?? ["sonnet", "opus"]
		this.effort = options.effort
	}

	async startSession(options: StartSessionOptions): Promise<AgentSession> {
		const session: ClaudeSession = {
			id: randomUUID(),
			provider: this.kind,
			model: options.model,
			workspace: options.workspace,
			taskId: options.taskId,
			state: "starting",
			createdAt: Date.now(),
			yolo: options.yolo ?? true,
			systemPrompt: options.systemPrompt,
			started: false,
		}
		this.sessions.set(session.id, session)
		return { ...session }
	}

	async *sendMessage(sessionId: string, message: string): AsyncIterable<AgentEvent> {
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Unknown Claude session: ${sessionId}`)
		if (this.active.has(sessionId)) throw new Error("Claude session is already running")

		const args = [
			this.executable,
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--model",
			session.model,
		]
		if (session.yolo) args.push("--permission-mode", "bypassPermissions")
		if (this.effort) args.push("--effort", this.effort)
		if (session.started) {
			args.push("--resume", session.id)
		} else {
			args.push("--session-id", session.id)
			if (session.systemPrompt) args.push("--append-system-prompt", session.systemPrompt)
		}
		args.push(message)

		session.state = "running"
		yield { type: "state.changed", state: "running" }
		const proc = Bun.spawn({
			cmd: args,
			cwd: session.workspace,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		})
		this.active.set(sessionId, proc)
		session.started = true
		let sawError = false

		try {
			for await (const line of lines(proc.stdout as ReadableStream<Uint8Array>)) {
				let parsed: ClaudeStreamEvent
				try {
					parsed = JSON.parse(line) as ClaudeStreamEvent
				} catch {
					continue
				}
				for (const event of mapClaudeEvent(parsed)) {
					if (event.type === "error") sawError = true
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
						message: stderr.trim() || `Claude exited with ${code}`,
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
		if (!session) throw new Error(`Unknown Claude session: ${sessionId}`)
		if (session.state === "interrupted" || session.state === "failed") session.state = "running"
	}

	snapshotSession(sessionId: string): AgentSessionSnapshot | null {
		const session = this.sessions.get(sessionId)
		if (!session) return null
		const { yolo, systemPrompt, started, ...sessionInfo } = session
		return {
			session: { ...sessionInfo },
			driverState: { yolo, systemPrompt, started },
		}
	}

	restoreSession(snapshot: AgentSessionSnapshot): void {
		const state = (snapshot.driverState ?? {}) as {
			yolo?: boolean
			systemPrompt?: string
			started?: boolean
		}
		this.sessions.set(snapshot.session.id, {
			...snapshot.session,
			yolo: state.yolo ?? true,
			systemPrompt: state.systemPrompt,
			started: state.started ?? true,
		})
	}

	async getModels(): Promise<AgentModel[]> {
		return this.models.map((id) => ({
			id,
			name: id,
			provider: this.kind,
			reasoning: true,
			toolCalling: true,
		}))
	}

	async getStatus(): Promise<AgentStatus> {
		const executable = Bun.which(this.executable)
		if (!executable)
			return { available: false, authenticated: false, detail: "Claude Code is not installed" }
		try {
			const proc = Bun.spawn({
				cmd: [executable, "auth", "status"],
				stdout: "pipe",
				stderr: "pipe",
			})
			const [code, stdout] = await Promise.all([
				proc.exited,
				new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			])
			const parsed = JSON.parse(stdout) as {
				loggedIn?: boolean
				authMethod?: string
				apiProvider?: string
			}
			return {
				available: true,
				authenticated: code === 0 && parsed.loggedIn === true,
				detail: JSON.stringify(parsed),
			}
		} catch (err) {
			return {
				available: true,
				authenticated: false,
				detail: err instanceof Error ? err.message : String(err),
			}
		}
	}

	getLoginCommand(): string[] {
		return [this.executable, "auth", "login"]
	}

	getSetupTokenCommand(): string[] {
		return [this.executable, "setup-token"]
	}
}
