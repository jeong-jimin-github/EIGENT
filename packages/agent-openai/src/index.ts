/** OpenAI Responses / Chat Completions compatible driver for EIGENT. */
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

export type OpenAIProtocol = "responses" | "chat_completions"

export interface OpenAICompatibleOptions {
	baseUrl: string
	apiKey?: string
	model?: string
	protocol?: OpenAIProtocol
	headers?: Record<string, string>
	contextLength?: number
	reasoning?: boolean
	toolCalling?: boolean
	vision?: boolean
}

interface OpenAISession extends AgentSession {
	systemPrompt?: string
	previousResponseId?: string
	history: Array<{ role: "user" | "assistant"; content: string }>
}

interface ResponseStreamEvent {
	type?: string
	delta?: string
	response?: { id?: string }
	item?: { id?: string; type?: string; name?: string; arguments?: string; output?: unknown }
}

interface ChatChunk {
	choices?: Array<{
		delta?: {
			content?: string
			reasoning_content?: string
			tool_calls?: Array<{
				index?: number
				id?: string
				function?: { name?: string; arguments?: string }
			}>
		}
		finish_reason?: string | null
	}>
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "")
}

async function* sseJson(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
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
				if (!raw || raw === "[DONE]") continue
				try {
					yield JSON.parse(raw)
				} catch {
					// Ignore provider-specific non-JSON SSE metadata.
				}
			}
		}
	}
}

export class OpenAICompatibleDriver implements AgentDriver {
	readonly kind = "openai" as const
	private readonly config: Required<Pick<OpenAICompatibleOptions, "baseUrl" | "protocol">> &
		OpenAICompatibleOptions
	private readonly sessions = new Map<string, OpenAISession>()
	private readonly active = new Map<string, AbortController>()

	constructor(options: OpenAICompatibleOptions) {
		this.config = {
			...options,
			baseUrl: normalizeBaseUrl(options.baseUrl),
			protocol: options.protocol ?? "responses",
		}
	}

	async startSession(options: StartSessionOptions): Promise<AgentSession> {
		const session: OpenAISession = {
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

	private headers(): HeadersInit {
		return {
			"content-type": "application/json",
			...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
			...this.config.headers,
		}
	}

	async *sendMessage(sessionId: string, message: string): AsyncIterable<AgentEvent> {
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Unknown OpenAI session: ${sessionId}`)
		if (this.active.has(sessionId)) throw new Error("OpenAI session is already running")
		if (!session.model) throw new Error("No model configured")

		const controller = new AbortController()
		this.active.set(sessionId, controller)
		session.state = "running"
		yield { type: "state.changed", state: "running" }

		try {
			if (this.config.protocol === "responses") {
				yield* this.sendResponses(session, message, controller.signal)
			} else {
				yield* this.sendChatCompletions(session, message, controller.signal)
			}
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

	private async *sendResponses(
		session: OpenAISession,
		message: string,
		signal: AbortSignal,
	): AsyncIterable<AgentEvent> {
		const response = await fetch(`${this.config.baseUrl}/responses`, {
			method: "POST",
			headers: this.headers(),
			signal,
			body: JSON.stringify({
				model: session.model,
				input: message,
				stream: true,
				...(session.systemPrompt ? { instructions: session.systemPrompt } : {}),
				...(session.previousResponseId ? { previous_response_id: session.previousResponseId } : {}),
			}),
		})
		if (!response.ok || !response.body) {
			throw new Error(`Responses API ${response.status}: ${await response.text()}`)
		}

		for await (const raw of sseJson(response.body)) {
			const event = raw as ResponseStreamEvent
			if (event.type === "response.created" && event.response?.id) {
				session.previousResponseId = event.response.id
			}
			if (event.type === "response.output_text.delta" && event.delta) {
				yield { type: "message.delta", text: event.delta }
			}
			if (
				(event.type === "response.reasoning_summary_text.delta" ||
					event.type === "response.reasoning_text.delta") &&
				event.delta
			) {
				yield { type: "reasoning.delta", text: event.delta }
			}
			if (
				event.type === "response.output_item.added" &&
				event.item?.type === "function_call" &&
				event.item.id
			) {
				yield {
					type: "tool.started",
					id: event.item.id,
					name: event.item.name ?? "function",
					input: event.item.arguments,
				}
			}
			if (
				event.type === "response.output_item.done" &&
				event.item?.type === "function_call" &&
				event.item.id
			) {
				yield { type: "tool.completed", id: event.item.id, name: event.item.name ?? "function" }
			}
		}
	}

	private async *sendChatCompletions(
		session: OpenAISession,
		message: string,
		signal: AbortSignal,
	): AsyncIterable<AgentEvent> {
		const messages = [
			...(session.systemPrompt ? [{ role: "system" as const, content: session.systemPrompt }] : []),
			...session.history,
			{ role: "user" as const, content: message },
		]
		const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.headers(),
			signal,
			body: JSON.stringify({ model: session.model, messages, stream: true }),
		})
		if (!response.ok || !response.body) {
			throw new Error(`Chat Completions API ${response.status}: ${await response.text()}`)
		}

		let assistant = ""
		const toolNames = new Map<number, { id: string; name: string }>()
		for await (const raw of sseJson(response.body)) {
			const chunk = raw as ChatChunk
			const delta = chunk.choices?.[0]?.delta
			if (delta?.content) {
				assistant += delta.content
				yield { type: "message.delta", text: delta.content }
			}
			if (delta?.reasoning_content) yield { type: "reasoning.delta", text: delta.reasoning_content }
			for (const tool of delta?.tool_calls ?? []) {
				const index = tool.index ?? 0
				if (tool.id && tool.function?.name && !toolNames.has(index)) {
					toolNames.set(index, { id: tool.id, name: tool.function.name })
					yield { type: "tool.started", id: tool.id, name: tool.function.name }
				}
			}
		}
		for (const tool of toolNames.values())
			yield { type: "tool.completed", id: tool.id, name: tool.name }
		session.history.push(
			{ role: "user", content: message },
			{ role: "assistant", content: assistant },
		)
	}

	async interrupt(sessionId: string): Promise<void> {
		this.active.get(sessionId)?.abort()
		const session = this.sessions.get(sessionId)
		if (session) session.state = "interrupted"
	}

	async resume(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId)
		if (!session) throw new Error(`Unknown OpenAI session: ${sessionId}`)
		if (session.state === "interrupted" || session.state === "failed") session.state = "running"
	}

	snapshotSession(sessionId: string): AgentSessionSnapshot | null {
		const session = this.sessions.get(sessionId)
		if (!session) return null
		const { systemPrompt, previousResponseId, history, ...sessionInfo } = session
		return {
			session: { ...sessionInfo },
			driverState: { systemPrompt, previousResponseId, history },
		}
	}

	restoreSession(snapshot: AgentSessionSnapshot): void {
		const state = (snapshot.driverState ?? {}) as {
			systemPrompt?: string
			previousResponseId?: string
			history?: Array<{ role: "user" | "assistant"; content: string }>
		}
		this.sessions.set(snapshot.session.id, {
			...snapshot.session,
			systemPrompt: state.systemPrompt,
			previousResponseId: state.previousResponseId,
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
						reasoning: this.config.reasoning,
						toolCalling: this.config.toolCalling,
						vision: this.config.vision,
					},
				]
			: []
	}

	async getStatus(): Promise<AgentStatus> {
		return {
			available: Boolean(this.config.baseUrl && this.config.model),
			authenticated: Boolean(this.config.apiKey),
			detail: `${this.config.protocol} @ ${this.config.baseUrl}`,
		}
	}
}
