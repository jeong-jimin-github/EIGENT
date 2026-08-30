/** Google Antigravity CLI driver for EIGENT. */
import { randomUUID } from "node:crypto"
import type {
	AgentDriver,
	AgentEvent,
	AgentModel,
	AgentSession,
	AgentStatus,
	StartSessionOptions,
} from "@eigent/agent-core"

const CLI_DEFAULT_MODEL = "__default__"

export interface AntigravityDriverOptions {
	executable?: string
	models?: string[]
	modelDiscoveryTimeoutMs?: number
	printTimeout?: string
	homeDir?: string
}

interface AntigravitySession extends AgentSession {
	conversationId?: string
	yolo: boolean
	systemPrompt?: string
}

interface AntigravityToolInfo {
	name?: string
	parameters?: unknown
	result?: unknown
	output?: unknown
	error?: unknown
}

export interface AntigravityStreamEvent {
	event?: string
	conversation_id?: string
	step_update?: {
		conversation_id?: string
		step_index?: number
		state?: string
		step_type?: string
		text_delta?: string
		tool_name?: string
		tool_info?: AntigravityToolInfo
	}
	result?: {
		conversation_id?: string
		status?: string
		response?: string
		error?: string
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

function toolId(event: AntigravityStreamEvent): string {
	const step = event.step_update
	return `${step?.conversation_id ?? event.conversation_id ?? "antigravity"}:${step?.step_index ?? "tool"}`
}

export function antigravityEvent(event: AntigravityStreamEvent): AgentEvent[] {
	const step = event.step_update
	if (event.event === "step_update" && step) {
		if (step.step_type === "agent_response" && step.text_delta) {
			return [{ type: "message.delta", text: step.text_delta }]
		}
		if ((step.step_type === "reasoning" || step.step_type === "thought") && step.text_delta) {
			return [{ type: "reasoning.delta", text: step.text_delta }]
		}
		if (step.step_type === "tool") {
			const id = toolId(event)
			const name = step.tool_name ?? step.tool_info?.name ?? "tool"
			if (step.state === "ACTIVE") {
				return [{ type: "tool.started", id, name, input: step.tool_info?.parameters }]
			}
			if (["DONE", "ERROR", "CANCELED", "INTERRUPTED"].includes(step.state ?? "")) {
				const output = step.tool_info?.output ?? step.tool_info?.result ?? step.tool_info?.error
				return [
					...(output !== undefined ? [{ type: "tool.output", id, output } as AgentEvent] : []),
					{ type: "tool.completed", id, name },
				]
			}
		}
	}

	if (event.event === "result" && event.result) {
		const status = event.result.status?.toUpperCase()
		if (status === "SUCCESS") return [{ type: "state.changed", state: "completed" }]
		if (status === "INTERRUPTED" || status === "CANCELED") {
			return [{ type: "state.changed", state: "interrupted" }]
		}
		if (status === "WAITING" || status === "RUNNING") {
			return [{ type: "state.changed", state: "waiting_input" }]
		}
		if (status === "ERROR" || status === "INVALID") {
			return [
				{
					type: "error",
					message: event.result.error || `Antigravity run ended with ${status}`,
					recoverable: true,
				},
				{ type: "state.changed", state: "failed" },
			]
		}
	}
	return []
}

export function parseAvailableModels(raw: string): string[] {
	let text = raw
	try {
		const parsed = JSON.parse(raw) as { error?: string }
		if (parsed.error) text = parsed.error
	} catch {
		// Older builds may print the discovery error as plain text.
	}
	const marker = "Available models:"
	const index = text.indexOf(marker)
	if (index < 0) return []
	return text
		.slice(index + marker.length)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
}

async function capture(
	cmd: string[],
	timeoutMs: number,
	cwd = process.cwd(),
	env: Record<string, string | undefined> = process.env,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
	const proc = Bun.spawn({ cmd, cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		proc.kill()
	}, timeoutMs)
	try {
		const [code, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		])
		return { code, stdout, stderr, timedOut }
	} finally {
		clearTimeout(timer)
	}
}

function toModel(id: string): AgentModel {
	return {
		id,
		name: id === CLI_DEFAULT_MODEL ? "CLI default" : id,
		provider: "antigravity",
		reasoning: true,
		vision: true,
		toolCalling: true,
	}
}

export class AntigravityDriver implements AgentDriver {
	readonly kind = "antigravity" as const
	private readonly executable: string
	private readonly configuredModels: string[]
	private readonly modelDiscoveryTimeoutMs: number
	private readonly printTimeout: string
	private readonly homeDir?: string
	private readonly sessions = new Map<string, AntigravitySession>()
	private readonly active = new Map<string, ReturnType<typeof Bun.spawn>>()
	private discoveredModels: AgentModel[] | null = null
	private lastAuthFailure: string | null = null

	constructor(options: AntigravityDriverOptions = {}) {
		this.executable = options.executable ?? "agy"
		this.configuredModels = options.models ?? []
		this.modelDiscoveryTimeoutMs = options.modelDiscoveryTimeoutMs ?? 1_500
		this.printTimeout = options.printTimeout ?? "10m"
		this.homeDir = options.homeDir
	}

	private spawnEnv(): Record<string, string | undefined> {
		if (!this.homeDir) return process.env
		return { ...process.env, HOME: this.homeDir, USERPROFILE: this.homeDir }
	}

	async startSession(options: StartSessionOptions): Promise<AgentSession> {
		const session: AntigravitySession = {
			id: randomUUID(),
			provider: this.kind,
			model: options.model,
			workspace: options.workspace,
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
		if (!session) throw new Error(`Unknown Antigravity session: ${sessionId}`)
		if (this.active.has(sessionId)) throw new Error("Antigravity session is already running")

		const prompt =
			session.systemPrompt && !session.conversationId
				? `${session.systemPrompt}\n\n${message}`
				: message
		const args = [
			this.executable,
			"-p",
			prompt,
			"--output-format",
			"stream-json",
			"--disable-slash-commands",
			"--print-timeout",
			this.printTimeout,
		]
		if (session.model !== CLI_DEFAULT_MODEL) args.push("--model", session.model)
		if (session.yolo) args.push("--dangerously-skip-permissions")
		if (session.conversationId) args.push("--conversation", session.conversationId)

		session.state = "running"
		yield { type: "state.changed", state: "running" }
		const proc = Bun.spawn({
			cmd: args,
			cwd: session.workspace,
			env: this.spawnEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		})
		this.active.set(sessionId, proc)
		let sawResult = false
		const stderrPromise = new Response(proc.stderr as ReadableStream<Uint8Array>).text()

		try {
			for await (const line of lines(proc.stdout as ReadableStream<Uint8Array>)) {
				let parsed: AntigravityStreamEvent
				try {
					parsed = JSON.parse(line) as AntigravityStreamEvent
				} catch {
					continue
				}
				const conversationId =
					parsed.conversation_id ??
					parsed.step_update?.conversation_id ??
					parsed.result?.conversation_id
				if (conversationId) session.conversationId = conversationId
				if (parsed.event === "result") {
					sawResult = true
					if (parsed.result?.status?.toUpperCase() === "SUCCESS") this.lastAuthFailure = null
				}
				for (const event of antigravityEvent(parsed)) {
					if (event.type === "error" && /auth|log(?:ged)? in|credential/i.test(event.message)) {
						this.lastAuthFailure = event.message
					}
					if (event.type === "state.changed") session.state = event.state
					yield event
				}
			}
			const code = await proc.exited
			const stderr = await stderrPromise
			if (!sawResult && session.state === "interrupted") {
				yield { type: "state.changed", state: "interrupted" }
			} else if (code === 0 && !sawResult) {
				session.state = "completed"
				yield { type: "state.changed", state: "completed" }
			} else if (code !== 0 && !sawResult) {
				const failure = stderr.trim() || `Antigravity exited with ${code}`
				if (/auth|log(?:ged)? in|credential/i.test(failure)) this.lastAuthFailure = failure
				session.state = "failed"
				yield { type: "error", message: failure, recoverable: true }
				yield { type: "state.changed", state: "failed" }
			}
		} finally {
			this.active.delete(sessionId)
		}
	}

	snapshotSession(sessionId: string): { session: AgentSession; driverState?: unknown } | null {
		const session = this.sessions.get(sessionId)
		if (!session) return null
		return {
			session: { ...session },
			driverState: {
				conversationId: session.conversationId,
				yolo: session.yolo,
				systemPrompt: session.systemPrompt,
			},
		}
	}

	restoreSession(snapshot: { session: AgentSession; driverState?: unknown }): void {
		if (snapshot.session.provider !== this.kind) return
		const state = (snapshot.driverState ?? {}) as {
			conversationId?: string
			yolo?: boolean
			systemPrompt?: string
		}
		this.sessions.set(snapshot.session.id, {
			...snapshot.session,
			conversationId: state.conversationId,
			yolo: state.yolo ?? true,
			systemPrompt: state.systemPrompt,
		})
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
		if (!session) throw new Error(`Unknown Antigravity session: ${sessionId}`)
		if (session.state === "interrupted" || session.state === "failed") session.state = "running"
	}

	async getModels(): Promise<AgentModel[]> {
		if (this.configuredModels.length) return this.configuredModels.map(toModel)
		if (this.discoveredModels) return this.discoveredModels.map((item) => ({ ...item }))
		const executable = Bun.which(this.executable)
		if (!executable) return []
		const probe = await capture(
			[
				executable,
				"-p",
				"EIGENT model discovery",
				"--model",
				"__EIGENT_MODEL_DISCOVERY__",
				"--output-format",
				"json",
				"--disable-slash-commands",
				"--print-timeout",
				"3s",
			],
			this.modelDiscoveryTimeoutMs,
			process.cwd(),
			this.spawnEnv(),
		)
		const fromStdout = parseAvailableModels(probe.stdout)
		const ids = fromStdout.length ? fromStdout : parseAvailableModels(probe.stderr)
		this.discoveredModels = [...new Set(ids.length ? ids : [CLI_DEFAULT_MODEL])].map(toModel)
		return this.discoveredModels.map((item) => ({ ...item }))
	}

	async getStatus(): Promise<AgentStatus> {
		const executable = Bun.which(this.executable)
		if (!executable) {
			return {
				available: false,
				authenticated: false,
				detail: "Antigravity CLI (agy) is not installed",
			}
		}
		if (this.lastAuthFailure) {
			return { available: true, authenticated: false, detail: this.lastAuthFailure }
		}
		// There is no cheap documented auth-status command. `agy --version` starts a
		// large native process and adds seconds of latency without validating login,
		// so authentication is validated on a real run and failures are remembered.
		return {
			available: true,
			authenticated: true,
			detail: "Antigravity CLI installed; cached keyring auth is validated on agent runs",
		}
	}
}
