/** Provider registry and agent-session routing for EIGENT. */

import { AnthropicCompatibleDriver } from "@eigent/agent-anthropic"
import { AntigravityDriver } from "@eigent/agent-antigravity"
import { ClaudeDriver } from "@eigent/agent-claude"
import { CodexDriver } from "@eigent/agent-codex"
import type {
	AgentDriver,
	AgentEvent,
	AgentModel,
	AgentProviderKind,
	AgentSession,
	AgentStatus,
	StartSessionOptions,
} from "@eigent/agent-core"
import { OpenAICompatibleDriver, type OpenAIProtocol } from "@eigent/agent-openai"
import { stateStore } from "./state"

export interface ProviderSnapshot {
	kind: AgentProviderKind
	status: AgentStatus
	models: AgentModel[]
}

interface RoutedSession {
	session: AgentSession
	driver: AgentDriver
}

function csv(value: string | undefined): string[] {
	return (
		value
			?.split(",")
			.map((item) => item.trim())
			.filter(Boolean) ?? []
	)
}

function buildDrivers(): Map<AgentProviderKind, AgentDriver> {
	const drivers = new Map<AgentProviderKind, AgentDriver>()
	drivers.set(
		"codex",
		new CodexDriver({
			executable: process.env.EIGENT_CODEX_EXECUTABLE,
			models: csv(process.env.EIGENT_CODEX_MODELS),
		}),
	)
	drivers.set(
		"antigravity",
		new AntigravityDriver({
			models: csv(process.env.EIGENT_ANTIGRAVITY_MODELS),
			homeDir: process.env.EIGENT_ANTIGRAVITY_HOME,
		}),
	)
	drivers.set(
		"claude",
		new ClaudeDriver({
			models: csv(process.env.EIGENT_CLAUDE_MODELS).length
				? csv(process.env.EIGENT_CLAUDE_MODELS)
				: ["sonnet", "opus"],
		}),
	)

	if (process.env.OPENAI_BASE_URL && process.env.OPENAI_MODEL) {
		drivers.set(
			"openai",
			new OpenAICompatibleDriver({
				baseUrl: process.env.OPENAI_BASE_URL,
				apiKey: process.env.OPENAI_API_KEY,
				model: process.env.OPENAI_MODEL,
				protocol: (process.env.OPENAI_API_PROTOCOL as OpenAIProtocol | undefined) ?? "responses",
				contextLength: Number(process.env.OPENAI_CONTEXT_LENGTH) || undefined,
				reasoning: process.env.OPENAI_REASONING !== "false",
				toolCalling: process.env.OPENAI_TOOL_CALLING !== "false",
				vision: process.env.OPENAI_VISION === "true",
			}),
		)
	}

	if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_MODEL) {
		drivers.set(
			"anthropic",
			new AnthropicCompatibleDriver({
				baseUrl: process.env.ANTHROPIC_BASE_URL,
				apiKey: process.env.ANTHROPIC_API_KEY,
				model: process.env.ANTHROPIC_MODEL,
				contextLength: Number(process.env.ANTHROPIC_CONTEXT_LENGTH) || undefined,
				vision: process.env.ANTHROPIC_VISION === "true",
			}),
		)
	}
	return drivers
}

export class ProviderRegistry {
	private readonly drivers = buildDrivers()
	private readonly sessions = new Map<string, RoutedSession>()

	constructor() {
		stateStore.markActiveAgentSessionsInterrupted()
		for (const persisted of stateStore.listAgentSessions()) {
			const driver = this.drivers.get(persisted.session.provider)
			if (!driver) continue
			const snapshot = {
				session: persisted.session,
				driverState: persisted.driverState,
			}
			driver.restoreSession(snapshot)
			this.sessions.set(persisted.session.id, { session: persisted.session, driver })
		}
	}

	private persist(routed: RoutedSession) {
		const snapshot = routed.driver.snapshotSession(routed.session.id)
		if (!snapshot) return
		routed.session = snapshot.session
		stateStore.saveAgentSnapshot(snapshot)
	}

	getDriver(kind: AgentProviderKind): AgentDriver {
		const driver = this.drivers.get(kind)
		if (!driver) throw new Error(`Provider ${kind} is not configured`)
		return driver
	}

	async snapshots(): Promise<ProviderSnapshot[]> {
		return Promise.all(
			[...this.drivers.entries()].map(async ([kind, driver]) => {
				const [status, models] = await Promise.all([driver.getStatus(), driver.getModels()])
				return { kind, status, models }
			}),
		)
	}

	async start(kind: AgentProviderKind, options: StartSessionOptions): Promise<AgentSession> {
		if (options.taskId) {
			const task = stateStore.getTask(options.taskId)
			if (!task) throw new Error(`Unknown task: ${options.taskId}`)
			if (task.workspace !== options.workspace) {
				throw new Error("Task workspace does not match agent workspace")
			}
		}
		const driver = this.getDriver(kind)
		const session = await driver.startSession(options)
		const routed = { session, driver }
		this.sessions.set(session.id, routed)
		this.persist(routed)
		stateStore.appendAgentEvent(session.id, { type: "session.started", session })
		return session
	}

	listSessions(workspace?: string): AgentSession[] {
		return stateStore.listAgentSessions(workspace).map((item) => item.session)
	}

	getSession(id: string): AgentSession | null {
		return this.sessions.get(id)?.session ?? stateStore.getAgentSession(id)?.session ?? null
	}

	setSessionState(id: string, state: AgentSession["state"]): void {
		const routed = this.sessions.get(id)
		if (!routed) return
		const snapshot = routed.driver.snapshotSession(id)
		const updated = {
			session: { ...(snapshot?.session ?? routed.session), state },
			driverState: snapshot?.driverState,
		}
		routed.driver.restoreSession(updated)
		routed.session = updated.session
		stateStore.saveAgentSnapshot(updated)
	}

	getEvents(id: string, afterSequence = 0) {
		return stateStore.listAgentEvents(id, afterSequence)
	}

	async *events(id: string, message: string): AsyncIterable<AgentEvent> {
		const routed = this.sessions.get(id)
		if (!routed)
			throw new Error(`Agent session ${id} cannot be restored with current provider config`)
		let lastSnapshotAt = 0
		let capturedProviderProgress = false
		try {
			for await (const event of routed.driver.sendMessage(id, message)) {
				// A CLI may still flush buffered stdout after an interrupt (especially through
				// Windows npm shims). Never persist those stale tool/message events.
				if (routed.driver.snapshotSession(id)?.session.state === "interrupted") break
				stateStore.appendAgentEvent(id, event)
				const now = Date.now()
				const shouldSnapshot =
					event.type === "state.changed" ||
					!capturedProviderProgress ||
					now - lastSnapshotAt >= 1_000
				if (shouldSnapshot) {
					this.persist(routed)
					lastSnapshotAt = now
					if (event.type !== "state.changed") capturedProviderProgress = true
				}
				yield event
			}
		} finally {
			this.persist(routed)
		}
	}

	async interrupt(id: string): Promise<void> {
		const routed = this.sessions.get(id)
		if (!routed) throw new Error(`Unknown agent session: ${id}`)
		await routed.driver.interrupt(id)
		this.persist(routed)
		stateStore.appendAgentEvent(id, { type: "state.changed", state: "interrupted" })
	}

	async resume(id: string): Promise<void> {
		const routed = this.sessions.get(id)
		if (!routed) throw new Error(`Unknown agent session: ${id}`)
		await routed.driver.resume(id)
		this.persist(routed)
		stateStore.appendAgentEvent(id, { type: "state.changed", state: routed.session.state })
	}
}

export const providerRegistry = new ProviderRegistry()
