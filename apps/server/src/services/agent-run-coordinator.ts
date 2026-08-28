/**
 * Decouples provider execution from an HTTP/SSE connection.
 *
 * A browser can disconnect while a run continues in the background. Every event
 * is persisted by ProviderRegistry and can be replayed from a sequence cursor.
 */
import { randomUUID } from "node:crypto"
import type { AgentEvent, AgentSession } from "@eigent/agent-core"
import type { PersistedAgentEvent, StateStore } from "./state-store"

export type RunTerminalEvent = Extract<
	AgentEvent,
	{ type: "run.completed" | "run.failed" | "run.interrupted" }
>

export function isRunTerminalEvent(event: AgentEvent): event is RunTerminalEvent {
	return (
		event.type === "run.completed" ||
		event.type === "run.failed" ||
		event.type === "run.interrupted"
	)
}

export interface AgentRunBackend {
	getSession(id: string): AgentSession | null
	events(id: string, message: string): AsyncIterable<AgentEvent>
	/** Keep the provider-side/in-memory session state aligned with durable run state. */
	setSessionState?(id: string, state: AgentSession["state"]): void
}

export interface AgentRunStart {
	requestId: string
	startSequence: number
	started: boolean
	state: AgentSession["state"]
}

interface ActiveRun {
	requestId: string
	promise: Promise<void>
}

export class AgentRunCoordinator {
	private readonly activeRuns = new Map<string, ActiveRun>()
	private readonly listeners = new Map<string, Set<() => void>>()

	constructor(
		private readonly backend: AgentRunBackend,
		private readonly store: StateStore,
	) {}

	private findRunRequest(sessionId: string, requestId: string): PersistedAgentEvent | null {
		return (
			this.store
				.listAgentEvents(sessionId)
				.find(
					(item) => item.event.type === "run.requested" && item.event.requestId === requestId,
				) ?? null
		)
	}

	private notify(sessionId: string) {
		for (const listener of this.listeners.get(sessionId) ?? []) listener()
	}

	private append(sessionId: string, event: AgentEvent): PersistedAgentEvent {
		const persisted = this.store.appendAgentEvent(sessionId, event)
		this.notify(sessionId)
		return persisted
	}

	start(sessionId: string, message: string, requestId: string = randomUUID()): AgentRunStart {
		const session = this.backend.getSession(sessionId)
		if (!session) throw new Error(`Unknown agent session: ${sessionId}`)

		const existing = this.findRunRequest(sessionId, requestId)
		if (existing) {
			return {
				requestId,
				startSequence: existing.sequence,
				started: false,
				state: this.backend.getSession(sessionId)?.state ?? session.state,
			}
		}

		const active = this.activeRuns.get(sessionId)
		if (active) {
			if (active.requestId === requestId) {
				return {
					requestId,
					startSequence: this.findRunRequest(sessionId, requestId)?.sequence ?? 0,
					started: false,
					state: session.state,
				}
			}
			throw new Error(`Agent session ${sessionId} is already running request ${active.requestId}`)
		}

		const requested = this.append(sessionId, { type: "run.requested", requestId, message })
		const promise = this.execute(sessionId, message, requestId)
		this.activeRuns.set(sessionId, { requestId, promise })
		void promise.finally(() => {
			const current = this.activeRuns.get(sessionId)
			if (current?.requestId === requestId) this.activeRuns.delete(sessionId)
			this.notify(sessionId)
		})

		return {
			requestId,
			startSequence: requested.sequence,
			started: true,
			state: session.state,
		}
	}

	private async execute(sessionId: string, message: string, requestId: string): Promise<void> {
		try {
			let providerError: string | undefined
			for await (const event of this.backend.events(sessionId, message)) {
				// ProviderRegistry persists normalized provider events. Wake replay subscribers.
				if (event.type === "error") providerError = event.message
				this.notify(sessionId)
			}
			const state = this.backend.getSession(sessionId)?.state
			if (state === "interrupted") {
				this.append(sessionId, { type: "run.interrupted", requestId })
			} else if (state === "failed") {
				this.append(sessionId, {
					type: "run.failed",
					requestId,
					message: providerError ?? "Agent run failed",
				})
			} else {
				this.append(sessionId, { type: "run.completed", requestId })
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			this.backend.setSessionState?.(sessionId, "failed")
			this.append(sessionId, { type: "state.changed", state: "failed" })
			this.append(sessionId, { type: "error", message, recoverable: true })
			this.append(sessionId, { type: "run.failed", requestId, message })
		}
	}

	isRunning(sessionId: string): boolean {
		return this.activeRuns.has(sessionId)
	}

	getActiveRequestId(sessionId: string): string | null {
		return this.activeRuns.get(sessionId)?.requestId ?? null
	}

	async waitForChange(sessionId: string, signal?: AbortSignal, timeoutMs = 15_000): Promise<void> {
		if (signal?.aborted) return
		await new Promise<void>((resolve) => {
			let settled = false
			const finish = () => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				signal?.removeEventListener("abort", finish)
				const set = this.listeners.get(sessionId)
				set?.delete(finish)
				if (set?.size === 0) this.listeners.delete(sessionId)
				resolve()
			}
			const timer = setTimeout(finish, timeoutMs)
			let set = this.listeners.get(sessionId)
			if (!set) {
				set = new Set()
				this.listeners.set(sessionId, set)
			}
			set.add(finish)
			signal?.addEventListener("abort", finish, { once: true })
		})
	}
}
