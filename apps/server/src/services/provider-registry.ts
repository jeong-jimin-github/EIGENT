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
		const driver = this.getDriver(kind)
		const session = await driver.startSession(options)
		this.sessions.set(session.id, { session, driver })
		return session
	}

	getSession(id: string): AgentSession | null {
		return this.sessions.get(id)?.session ?? null
	}

	events(id: string, message: string): AsyncIterable<AgentEvent> {
		const routed = this.sessions.get(id)
		if (!routed) throw new Error(`Unknown agent session: ${id}`)
		return routed.driver.sendMessage(id, message)
	}

	async interrupt(id: string): Promise<void> {
		const routed = this.sessions.get(id)
		if (!routed) throw new Error(`Unknown agent session: ${id}`)
		await routed.driver.interrupt(id)
	}

	async resume(id: string): Promise<void> {
		const routed = this.sessions.get(id)
		if (!routed) throw new Error(`Unknown agent session: ${id}`)
		await routed.driver.resume(id)
	}
}

export const providerRegistry = new ProviderRegistry()
