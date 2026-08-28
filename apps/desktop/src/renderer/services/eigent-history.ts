import type { PersistedUnifiedAgentEvent } from "./eigent-agents"

export interface ReplayedUnifiedTool {
	id: string
	name: string
	input: Record<string, unknown>
	output: string
	startedAt: number
	completedAt?: number
}

export interface ReplayedUnifiedQuestion {
	id: string
	prompt: string
}

export interface ReplayedUnifiedRun {
	requestId: string
	message: string
	createdAt: number
	sequence: number
	text: string
	reasoning: string
	tools: ReplayedUnifiedTool[]
	questions: ReplayedUnifiedQuestion[]
	waitingInput: boolean
	completedAt?: number
	error?: string
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

function asInput(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

/**
 * Reconstruct provider-independent turns from the durable normalized event log.
 *
 * The server persists every AgentEvent, so this lets the inherited Palot chat UI
 * restore a unified-provider conversation after a browser refresh without asking
 * any provider-specific API for history.
 */
export function replayUnifiedAgentRuns(events: PersistedUnifiedAgentEvent[]): ReplayedUnifiedRun[] {
	const runs: ReplayedUnifiedRun[] = []
	let current: ReplayedUnifiedRun | undefined
	let tools = new Map<string, ReplayedUnifiedTool>()

	for (const item of events) {
		const event = item.event
		if (event.type === "run.requested") {
			current = {
				requestId: String(event.requestId ?? ""),
				message: String(event.message ?? ""),
				createdAt: item.createdAt,
				sequence: item.sequence,
				text: "",
				reasoning: "",
				tools: [],
				questions: [],
				waitingInput: false,
			}
			tools = new Map()
			runs.push(current)
			continue
		}
		if (!current) continue

		switch (event.type) {
			case "message.delta":
				current.text += String(event.text ?? "")
				break
			case "reasoning.delta":
				current.reasoning += String(event.text ?? "")
				break
			case "tool.started": {
				const id = String(event.id ?? `tool-${item.sequence}`)
				const tool: ReplayedUnifiedTool = {
					id,
					name: String(event.name ?? "tool"),
					input: asInput(event.input),
					output: "",
					startedAt: item.createdAt,
				}
				tools.set(id, tool)
				current.tools.push(tool)
				break
			}
			case "tool.output": {
				const id = String(event.id ?? `tool-${item.sequence}`)
				let tool = tools.get(id)
				if (!tool) {
					tool = {
						id,
						name: "tool",
						input: {},
						output: "",
						startedAt: item.createdAt,
					}
					tools.set(id, tool)
					current.tools.push(tool)
				}
				tool.output += stringify(event.output)
				break
			}
			case "tool.completed": {
				const id = String(event.id ?? `tool-${item.sequence}`)
				let tool = tools.get(id)
				if (!tool) {
					tool = {
						id,
						name: String(event.name ?? "tool"),
						input: {},
						output: "",
						startedAt: item.createdAt,
					}
					tools.set(id, tool)
					current.tools.push(tool)
				}
				tool.name = String(event.name ?? tool.name)
				tool.completedAt = item.createdAt
				break
			}
			case "terminal.output": {
				const id = `terminal-${String(event.processId ?? "process")}`
				let tool = tools.get(id)
				if (!tool) {
					tool = {
						id,
						name: "bash",
						input: { command: `process ${String(event.processId ?? "")}` },
						output: "",
						startedAt: item.createdAt,
					}
					tools.set(id, tool)
					current.tools.push(tool)
				}
				tool.output += String(event.data ?? "")
				break
			}
			case "file.changed": {
				const path = String(event.path ?? "")
				const tool: ReplayedUnifiedTool = {
					id: `file-${item.sequence}`,
					name: "File changed",
					input: { path },
					output: path,
					startedAt: item.createdAt,
					completedAt: item.createdAt,
				}
				tools.set(tool.id, tool)
				current.tools.push(tool)
				break
			}
			case "question":
				current.questions.push({
					id: String(event.id ?? `question-${item.sequence}`),
					prompt: String(event.prompt ?? "The agent is waiting for input."),
				})
				current.waitingInput = true
				break
			case "state.changed": {
				const state = String(event.state ?? "")
				if (state === "waiting_input") current.waitingInput = true
				else if (state === "starting" || state === "running") current.waitingInput = false
				else if (state === "failed" || state === "interrupted") current.waitingInput = false
				break
			}
			case "run.failed":
				if (String(event.requestId ?? "") === current.requestId) {
					current.error = String(event.message ?? "AgentDriver run failed")
					current.completedAt = item.createdAt
					current.waitingInput = false
				}
				break
			case "run.interrupted":
				if (String(event.requestId ?? "") === current.requestId) {
					current.completedAt = item.createdAt
					current.waitingInput = false
				}
				break
			case "run.completed":
				if (String(event.requestId ?? "") === current.requestId) {
					current.completedAt = item.createdAt
				}
				break
			case "error":
				current.error = String(event.message ?? "AgentDriver run failed")
				break
		}
	}

	return runs
}
