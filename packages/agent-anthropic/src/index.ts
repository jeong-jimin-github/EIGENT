/** Anthropic Messages API compatible driver for EIGENT. */
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

export interface AnthropicCompatibleOptions {
	baseUrl: string
	apiKey?: string
	model?: string
	anthropicVersion?: string
	maxTokens?: number
	headers?: Record<string, string>
	contextLength?: number
	vision?: boolean
}

interface Session extends AgentSession {
	systemPrompt?: string
	history: Array<{ role: "user" | "assistant"; content: string }>
}

interface StreamEvent {
	type?: string
	index?: number
	content_block?: { type?: string; id?: string; name?: string; input?: unknown }
	delta?: { type?: string; text?: string; thinking?: string }
	error?: { message?: string }
}

async function* sse(stream: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let buffer = ""
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		buffer += decoder.decode(value, { stream: true })
		const blocks = buffer.split(/\r?\n\r?\n/)
		buffer = blocks.pop() ?? ""
		for (const block of blocks) {
			for (const line of block.split(/\r?\n/)) {
				if (!line.startsWith("data:")) continue
				const raw = line.slice(5).trim()
				if (!raw) continue
				try {
					yield JSON.parse(raw) as StreamEvent
				} catch {
					// Compatibility endpoints may add non-JSON metadata.
				}
			}
		}
	}
}

export class AnthropicCompatibleDriver implements AgentDriver {
	readonly kind = "anthropic" as const
	private readonly config: AnthropicCompatibleOptions & {
		baseUrl: string
		anthropicVersion: string
		maxTokens: number
	}
	private readonly sessions = new Map<string, Session>()
	private readonly active = new Map<string, AbortController>()

	constructor(options: AnthropicCompatibleOptions) {
		this.config = {
			...options,
			baseUrl: options.baseUrl.replace(/\/+$/, ""),
			anthropicVersion: options.anthropicVersion ?? "2023-06-01",
			maxTokens: options.maxTokens ?? 8192,
		}
	}

	async startSession(options: StartSessionOptions): Promise<AgentSession> {
		const session: Session = {
			id: randomUUID(),
			provider: this.kind,
			model: options.model || this.config.model || "",
			workspace: options.workspace,
			taskId: options.taskId,
			state: "starting",
			createdAt: Date.now(),
			systemPrompt: options.systemPrompt,
			history: [],
		}
		this.sessions.set(session.id, session)
		return { ...session }
	}

	async *sendMessage(sessionId: string, message: string): AsyncIterable<AgentEvent> {
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Unknown Anthropic session: ${sessionId}`)
		if (this.active.has(sessionId)) throw new Error("Anthropic session is already running")
		if (!session.model) throw new Error("No model configured")

		const controller = new AbortController()
		this.active.set(sessionId, controller)
		session.state = "running"
		yield { type: "state.changed", state: "running" }
		let assistant = ""
		const tools = new Map<number, { id: string; name: string }>()

		try {
			const response = await fetch(`${this.config.baseUrl}/messages`, {
				method: "POST",
				signal: controller.signal,
				headers: {
					"content-type": "application/json",
					"anthropic-version": this.config.anthropicVersion,
					...(this.config.apiKey ? { "x-api-key": this.config.apiKey } : {}),
					...this.config.headers,
				},
				body: JSON.stringify({
					model: session.model,
					max_tokens: this.config.maxTokens,
					stream: true,
					...(session.systemPrompt ? { system: session.systemPrompt } : {}),
					messages: [...session.history, { role: "user", content: message }],
				}),
			})
			if (!response.ok || !response.body) {
				throw new Error(`Anthropic Messages API ${response.status}: ${await response.text()}`)
			}

			for await (const event of sse(response.body)) {
				if (
					event.type === "content_block_start" &&
					event.content_block?.type === "tool_use" &&
					event.content_block.id
				) {
					const name = event.content_block.name ?? "tool"
					tools.set(event.index ?? 0, { id: event.content_block.id, name })
					yield {
						type: "tool.started",
						id: event.content_block.id,
						name,
						input: event.content_block.input,
					}
				}
				if (
					event.type === "content_block_delta" &&
					event.delta?.type === "text_delta" &&
					event.delta.text
				) {
					assistant += event.delta.text
					yield { type: "message.delta", text: event.delta.text }
				}
				if (
					event.type === "content_block_delta" &&
					event.delta?.type === "thinking_delta" &&
					event.delta.thinking
				) {
					yield { type: "reasoning.delta", text: event.delta.thinking }
				}
				if (event.type === "content_block_stop") {
					const tool = tools.get(event.index ?? 0)
					if (tool) yield { type: "tool.completed", id: tool.id, name: tool.name }
				}
				if (event.type === "error")
					throw new Error(event.error?.message ?? "Anthropic stream error")
			}

			session.history.push(
				{ role: "user", content: message },
				{ role: "assistant", content: assistant },
			)
			if (!controller.signal.aborted) {
				session.state = "completed"
				yield { type: "state.changed", state: "completed" }
			}
		} catch (err) {
			if (controller.signal.aborted) return
			session.state = "failed"
			yield {
				type: "error",
				message: err instanceof Error ? err.message : String(err),
				recoverable: true,
			}
			yield { type: "state.changed", state: "failed" }
		} finally {
			this.active.delete(sessionId)
		}
	}

	async interrupt(sessionId: string): Promise<void> {
		this.active.get(sessionId)?.abort()
		const session = this.sessions.get(sessionId)
		if (session) session.state = "interrupted"
	}

	async resume(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Unknown Anthropic session: ${sessionId}`)
		if (session.state === "interrupted" || session.state === "failed") session.state = "running"
	}

	snapshotSession(sessionId: string): AgentSessionSnapshot | null {
		const session = this.sessions.get(sessionId)
		if (!session) return null
		const { systemPrompt, history, ...sessionInfo } = session
		return {
			session: { ...sessionInfo },
			driverState: { systemPrompt, history },
		}
	}

	restoreSession(snapshot: AgentSessionSnapshot): void {
		const state = (snapshot.driverState ?? {}) as {
			systemPrompt?: string
			history?: Array<{ role: "user" | "assistant"; content: string }>
		}
		this.sessions.set(snapshot.session.id, {
			...snapshot.session,
			systemPrompt: state.systemPrompt,
			history: state.history ?? [],
		})
	}

	async getModels(): Promise<AgentModel[]> {
		const id = this.config.model
		return id
			? [
					{
						id,
						name: id,
						provider: this.kind,
						contextLength: this.config.contextLength,
						reasoning: true,
						toolCalling: true,
						vision: this.config.vision,
					},
				]
			: []
	}

	async getStatus(): Promise<AgentStatus> {
		return {
			available: Boolean(this.config.baseUrl && this.config.model),
			authenticated: Boolean(this.config.apiKey),
			detail: `messages @ ${this.config.baseUrl}`,
		}
	}
}
