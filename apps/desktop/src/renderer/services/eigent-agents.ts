import { runAgentMessage, type SequencedAgentEvent } from "./eigent-recovery"

export type AgentRuntimeProvider =
	| "opencode"
	| "codex"
	| "claude"
	| "antigravity"
	| "openai"
	| "anthropic"

export interface AgentRuntimeSelection {
	provider: AgentRuntimeProvider
	model?: string
}

export interface AgentProviderStatus {
	available: boolean
	authenticated: boolean
	detail?: string
}

export interface AgentProviderModel {
	id: string
	name: string
	provider: Exclude<AgentRuntimeProvider, "opencode">
	contextLength?: number
	reasoning?: boolean
	vision?: boolean
	toolCalling?: boolean
}

export interface AgentProviderSnapshot {
	kind: Exclude<AgentRuntimeProvider, "opencode">
	status: AgentProviderStatus
	models: AgentProviderModel[]
}

export interface PersistedUnifiedAgentEvent extends SequencedAgentEvent {
	createdAt: number
}

export interface UnifiedAgentSession {
	id: string
	provider: Exclude<AgentRuntimeProvider, "opencode">
	model: string
	workspace: string
	taskId?: string
	state: "starting" | "running" | "waiting_input" | "completed" | "failed" | "interrupted"
	createdAt: number
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init)
	const data = (await response.json()) as T & { error?: unknown }
	if (!response.ok) {
		throw new Error(
			typeof data.error === "string" ? data.error : `${response.status} ${response.statusText}`,
		)
	}
	return data
}

export async function fetchAgentProviders(signal?: AbortSignal): Promise<AgentProviderSnapshot[]> {
	const data = await jsonRequest<{ providers: AgentProviderSnapshot[] }>("/api/agents/providers", {
		signal,
	})
	return data.providers
}

export async function fetchUnifiedAgentEvents(
	sessionId: string,
	afterSequence = 0,
	signal?: AbortSignal,
): Promise<PersistedUnifiedAgentEvent[]> {
	const query = new URLSearchParams({ after: String(Math.max(0, afterSequence)) })
	const data = await jsonRequest<{ events: PersistedUnifiedAgentEvent[] }>(
		`/api/agents/sessions/${encodeURIComponent(sessionId)}/events?${query}`,
		{ signal },
	)
	return data.events
}

export async function fetchUnifiedAgentSession(
	sessionId: string,
	signal?: AbortSignal,
): Promise<UnifiedAgentSession> {
	return jsonRequest<UnifiedAgentSession>(`/api/agents/sessions/${encodeURIComponent(sessionId)}`, {
		signal,
	})
}

export async function createUnifiedAgentSession(args: {
	provider: Exclude<AgentRuntimeProvider, "opencode">
	workspace: string
	model: string
	taskId?: string
	yolo?: boolean
	systemPrompt?: string
}): Promise<UnifiedAgentSession> {
	return jsonRequest<UnifiedAgentSession>("/api/agents/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...args, yolo: args.yolo ?? true }),
	})
}

export async function interruptUnifiedAgentSession(sessionId: string): Promise<void> {
	await jsonRequest<{ interrupted: true }>(
		`/api/agents/sessions/${encodeURIComponent(sessionId)}/interrupt`,
		{ method: "POST" },
	)
}

export async function resumeUnifiedAgentSession(sessionId: string): Promise<void> {
	await jsonRequest<{ resumed: true }>(
		`/api/agents/sessions/${encodeURIComponent(sessionId)}/resume`,
		{ method: "POST" },
	)
}

export { runAgentMessage }
export type { SequencedAgentEvent }
