/** Provider-independent agent contracts used by the EIGENT server and workers. */

export type AgentProviderKind =
	| "codex"
	| "claude"
	| "antigravity"
	| "openai"
	| "anthropic"
	| "opencode"

export type AgentSessionState =
	| "starting"
	| "running"
	| "waiting_input"
	| "completed"
	| "failed"
	| "interrupted"

export interface AgentModel {
	id: string
	name: string
	provider: AgentProviderKind
	contextLength?: number
	reasoning?: boolean
	vision?: boolean
	toolCalling?: boolean
}

export interface AgentSession {
	id: string
	provider: AgentProviderKind
	model: string
	workspace: string
	taskId?: string
	state: AgentSessionState
	createdAt: number
}

export interface StartSessionOptions {
	workspace: string
	model: string
	taskId?: string
	yolo?: boolean
	systemPrompt?: string
}

export type AgentEvent =
	| { type: "session.started"; session: AgentSession }
	| { type: "message.delta"; text: string }
	| { type: "reasoning.delta"; text: string }
	| { type: "tool.started"; id: string; name: string; input?: unknown }
	| { type: "tool.output"; id: string; output: unknown }
	| { type: "tool.completed"; id: string; name: string }
	| { type: "file.changed"; path: string }
	| { type: "terminal.output"; processId: string; data: string }
	| { type: "question"; id: string; prompt: string }
	| { type: "permission"; id: string; prompt: string }
	| { type: "run.requested"; requestId: string; message: string }
	| { type: "run.completed"; requestId: string }
	| { type: "run.failed"; requestId: string; message: string }
	| { type: "run.interrupted"; requestId: string }
	| { type: "state.changed"; state: AgentSessionState }
	| { type: "error"; message: string; recoverable: boolean }

export interface AgentSessionSnapshot {
	session: AgentSession
	driverState?: unknown
}

export interface AgentStatus {
	available: boolean
	authenticated: boolean
	detail?: string
}

export interface AgentDriver {
	readonly kind: AgentProviderKind
	startSession(options: StartSessionOptions): Promise<AgentSession>
	sendMessage(sessionId: string, message: string): AsyncIterable<AgentEvent>
	interrupt(sessionId: string): Promise<void>
	resume(sessionId: string): Promise<void>
	getModels(): Promise<AgentModel[]>
	getStatus(): Promise<AgentStatus>
	snapshotSession(sessionId: string): AgentSessionSnapshot | null
	restoreSession(snapshot: AgentSessionSnapshot): void
}

export const DEFAULT_YOLO_MODE = true
