import { upsertMessageAtom } from "../atoms/messages"
import { applyPartDeltaAtom, upsertPartAtom } from "../atoms/parts"
import { addQuestionAtom, setSessionErrorAtom, setSessionStatusAtom } from "../atoms/sessions"
import { appStore } from "../atoms/store"
import type {
	AssistantMessage,
	QuestionRequest,
	ReasoningPart,
	TextPart,
	ToolPart,
	UserMessage,
} from "../lib/types"
import {
	createUnifiedAgentSession,
	fetchUnifiedAgentEvents,
	fetchUnifiedAgentSession,
	interruptUnifiedAgentSession,
	resumeUnifiedAgentSession,
	runAgentMessage,
	type AgentRuntimeSelection,
	type SequencedAgentEvent,
	type UnifiedAgentSession,
} from "./eigent-agents"
import { replayUnifiedAgentRuns } from "./eigent-history"
import { workspaceAgentSystemPrompt } from "./workspace-agent-context"
import { streamAgentEvents } from "./eigent-recovery"

const activeRuns = new Map<string, { agentSessionId: string; controller: AbortController }>()

export function isUnifiedAgentPromptActive(uiSessionId: string, agentSessionId?: string): boolean {
	const active = activeRuns.get(uiSessionId)
	if (!active) return false
	return !agentSessionId || active.agentSessionId === agentSessionId
}

function setBusy(sessionId: string, busy: boolean): void {
	appStore.set(setSessionStatusAtom, { sessionId, status: { type: busy ? "busy" : "idle" } })
}

function setError(sessionId: string, message: string): void {
	appStore.set(setSessionErrorAtom, {
		sessionId,
		error: { name: "AgentDriverError", data: { message } },
	})
}

function addUnifiedQuestion(sessionId: string, id: string, prompt: string): void {
	const question: QuestionRequest = {
		id,
		sessionID: sessionId,
		questions: [
			{
				question: prompt,
				header: "Agent question",
				options: [],
				custom: true,
			},
		],
	}
	appStore.set(addQuestionAtom, { sessionId, question })
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

export async function hydrateUnifiedAgentHistory(args: {
	uiSessionId: string
	workspace: string
	runtime: AgentRuntimeSelection
	agentSessionId: string
	signal?: AbortSignal
}): Promise<{ lastSequence: number; state?: UnifiedAgentSession["state"] }> {
	if (args.runtime.provider === "opencode") return { lastSequence: 0 }
	if (!args.runtime.model) return { lastSequence: 0 }

	const [session, events] = await Promise.all([
		fetchUnifiedAgentSession(args.agentSessionId, args.signal),
		fetchUnifiedAgentEvents(args.agentSessionId, 0, args.signal),
	])
	if (
		session.provider !== args.runtime.provider ||
		session.model !== args.runtime.model ||
		(args.workspace && session.workspace !== args.workspace)
	) {
		return { lastSequence: 0 }
	}

	const runs = replayUnifiedAgentRuns(events)
	for (const run of runs) {
		const timeKey = String(run.createdAt).padStart(13, "0")
		const sequenceKey = String(run.sequence).padStart(8, "0")
		const baseId = `optimistic-${timeKey}-${sequenceKey}-${run.requestId}`
		const userId = `${baseId}-0-user`
		const assistantId = `${baseId}-1-assistant`
		const user: UserMessage = {
			id: userId,
			sessionID: args.uiSessionId,
			role: "user",
			time: { created: run.createdAt },
			agent: "build",
			model: { providerID: session.provider, modelID: session.model },
		}
		const assistant: AssistantMessage = {
			id: assistantId,
			sessionID: args.uiSessionId,
			role: "assistant",
			time: { created: run.createdAt, ...(run.completedAt ? { completed: run.completedAt } : {}) },
			parentID: userId,
			modelID: session.model,
			providerID: session.provider,
			mode: "build",
			agent: "build",
			path: { cwd: args.workspace, root: args.workspace },
			cost: 0,
			tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
		}

		appStore.set(upsertMessageAtom, user)
		appStore.set(upsertPartAtom, {
			id: `${userId}-text`,
			sessionID: args.uiSessionId,
			messageID: userId,
			type: "text",
			text: run.message,
			time: { start: run.createdAt, end: run.createdAt },
		} satisfies TextPart)
		appStore.set(upsertMessageAtom, assistant)

		if (run.reasoning) {
			appStore.set(upsertPartAtom, {
				id: `${assistantId}-reasoning`,
				sessionID: args.uiSessionId,
				messageID: assistantId,
				type: "reasoning",
				text: run.reasoning,
				time: {
					start: run.createdAt,
					...(run.completedAt ? { end: run.completedAt } : {}),
				},
			} satisfies ReasoningPart)
		}
		if (run.text) {
			appStore.set(upsertPartAtom, {
				id: `${assistantId}-text`,
				sessionID: args.uiSessionId,
				messageID: assistantId,
				type: "text",
				text: run.text,
				time: {
					start: run.createdAt,
					...(run.completedAt ? { end: run.completedAt } : {}),
				},
			} satisfies TextPart)
		}
		for (const tool of run.tools) {
			const end = tool.completedAt ?? run.completedAt
			const part: ToolPart = end
				? {
					id: `${assistantId}-tool-${tool.id}`,
					sessionID: args.uiSessionId,
					messageID: assistantId,
					type: "tool",
					callID: tool.id,
					tool: tool.name,
					state: {
						status: "completed",
						input: tool.input,
						output: tool.output,
						title: tool.name,
						metadata: {},
						time: { start: tool.startedAt, end },
					},
				}
				: {
					id: `${assistantId}-tool-${tool.id}`,
					sessionID: args.uiSessionId,
					messageID: assistantId,
					type: "tool",
					callID: tool.id,
					tool: tool.name,
					state: {
						status: "running",
						input: tool.input,
						metadata: { output: tool.output },
						time: { start: tool.startedAt },
					},
				}
			appStore.set(upsertPartAtom, part)
		}
	}

	const latest = runs.at(-1)
	appStore.set(setSessionErrorAtom, {
		sessionId: args.uiSessionId,
		error: latest?.error
			? { name: "AgentDriverError", data: { message: latest.error } }
			: undefined,
	})
	if (latest?.waitingInput) {
		const questions = latest.questions.length
			? latest.questions
			: [{ id: `unified-waiting-${args.agentSessionId}-${latest.sequence}`, prompt: "The agent is waiting for additional input." }]
		for (const question of questions) {
			addUnifiedQuestion(args.uiSessionId, question.id, question.prompt)
		}
	}
	setBusy(args.uiSessionId, session.state === "starting" || session.state === "running")

	return { lastSequence: events.at(-1)?.sequence ?? 0, state: session.state }
}

export async function followUnifiedAgentHistory(args: {
	uiSessionId: string
	workspace: string
	runtime: AgentRuntimeSelection
	agentSessionId: string
	afterSequence: number
	signal: AbortSignal
}): Promise<void> {
	const streamController = new AbortController()
	const abortStream = () => streamController.abort()
	args.signal.addEventListener("abort", abortStream, { once: true })

	let refreshTimer: ReturnType<typeof setTimeout> | undefined
	let terminalSeen = false
	const refresh = async () => {
		if (args.signal.aborted) return
		await hydrateUnifiedAgentHistory({
			uiSessionId: args.uiSessionId,
			workspace: args.workspace,
			runtime: args.runtime,
			agentSessionId: args.agentSessionId,
			signal: args.signal,
		})
	}
	const scheduleRefresh = () => {
		if (refreshTimer) return
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined
			void refresh().catch(() => undefined)
		}, 50)
	}

	try {
		await streamAgentEvents(
			args.agentSessionId,
			args.afterSequence,
			(item) => {
				scheduleRefresh()
				if (["run.completed", "run.failed", "run.interrupted"].includes(item.event.type)) {
					terminalSeen = true
					streamController.abort()
				}
			},
			streamController.signal,
		)
	} finally {
		args.signal.removeEventListener("abort", abortStream)
		if (refreshTimer) {
			clearTimeout(refreshTimer)
			refreshTimer = undefined
		}
		if (terminalSeen && !args.signal.aborted) await refresh()
	}
}

export async function sendUnifiedAgentPrompt(args: {
	uiSessionId: string
	workspace: string
	runtime: AgentRuntimeSelection
	message: string
	agentSessionId?: string
	onAgentSession?: (id: string) => void
}): Promise<string> {
	if (args.runtime.provider === "opencode") throw new Error("OpenCode uses the legacy transport")
	if (!args.runtime.model) throw new Error("Select a model before sending")

	let agentSessionId = args.agentSessionId
	if (agentSessionId) {
		try {
			const session = await fetchUnifiedAgentSession(agentSessionId)
			const matchesRuntime =
				session.provider === args.runtime.provider &&
				session.model === args.runtime.model &&
				(!args.workspace || session.workspace === args.workspace)
			if (!matchesRuntime) {
				agentSessionId = undefined
			} else if (session.state === "interrupted" || session.state === "failed") {
				await resumeUnifiedAgentSession(agentSessionId)
			}
		} catch {
			// Stale persisted provider-session IDs are replaced transparently.
			agentSessionId = undefined
		}
	}

	// Project the user's message immediately. Session/provider startup may fail or
	// take several seconds on a small VPS; the user's submitted text must never disappear.
	const stamp = Date.now()
	const nonce = crypto.randomUUID()
	const userId = `optimistic-${stamp}-0-${nonce}`
	const assistantId = `optimistic-${stamp}-1-${nonce}`
	const textId = `${assistantId}-text`
	const reasoningId = `${assistantId}-reasoning`
	const now = Date.now()
	const model = args.runtime.model
	const provider = args.runtime.provider

	const user: UserMessage = {
		id: userId,
		sessionID: args.uiSessionId,
		role: "user",
		time: { created: now },
		agent: "build",
		model: { providerID: provider, modelID: model },
	}
	let assistant: AssistantMessage = {
		id: assistantId,
		sessionID: args.uiSessionId,
		role: "assistant",
		time: { created: now },
		parentID: userId,
		modelID: model,
		providerID: provider,
		mode: "build",
		agent: "build",
		path: { cwd: args.workspace, root: args.workspace },
		cost: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
	}
	appStore.set(upsertMessageAtom, user)
	appStore.set(upsertPartAtom, {
		id: `${userId}-text`,
		sessionID: args.uiSessionId,
		messageID: userId,
		type: "text",
		text: args.message,
		time: { start: now, end: now },
	} satisfies TextPart)
	appStore.set(upsertMessageAtom, assistant)

	try {
		if (!agentSessionId) {
			const systemPrompt = await workspaceAgentSystemPrompt(args.workspace, args.message)
			const session = await createUnifiedAgentSession({
				provider: args.runtime.provider,
				workspace: args.workspace,
				model: args.runtime.model,
				yolo: true,
				systemPrompt,
				uiSessionId: args.uiSessionId,
			})
			agentSessionId = session.id
			args.onAgentSession?.(agentSessionId)
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		setError(args.uiSessionId, message)
		setBusy(args.uiSessionId, false)
		assistant = { ...assistant, time: { ...assistant.time, completed: Date.now() } }
		appStore.set(upsertMessageAtom, assistant)
		throw error
	}

	const controller = new AbortController()
	activeRuns.set(args.uiSessionId, { agentSessionId, controller })
	setBusy(args.uiSessionId, true)
	appStore.set(setSessionErrorAtom, { sessionId: args.uiSessionId, error: undefined })

	let hasText = false
	let hasReasoning = false
	let sawQuestion = false
	let finalState: string | undefined
	const tools = new Map<string, ToolPart>()
	const outputs = new Map<string, string>()

	const ensureText = (reasoning = false) => {
		if (reasoning ? hasReasoning : hasText) return
		if (reasoning) hasReasoning = true
		else hasText = true
		const id = reasoning ? reasoningId : textId
		appStore.set(upsertPartAtom, {
			id,
			sessionID: args.uiSessionId,
			messageID: assistantId,
			type: reasoning ? "reasoning" : "text",
			text: "",
			time: { start: Date.now() },
		} as TextPart | ReasoningPart)
	}

	const appendText = (delta: string, reasoning = false) => {
		ensureText(reasoning)
		appStore.set(applyPartDeltaAtom, {
			messageId: assistantId,
			partId: reasoning ? reasoningId : textId,
			field: "text",
			delta,
		})
	}

	const upsertRunningTool = (id: string, name: string, input: Record<string, unknown>) => {
		const existing = tools.get(id)
		const start = existing?.state.status === "running" ? existing.state.time.start : Date.now()
		const part: ToolPart = {
			id: existing?.id ?? `${assistantId}-tool-${id}`,
			sessionID: args.uiSessionId,
			messageID: assistantId,
			type: "tool",
			callID: id,
			tool: name,
			state: {
				status: "running",
				input,
				metadata: { output: outputs.get(id) ?? "" },
				time: { start },
			},
		}
		tools.set(id, part)
		appStore.set(upsertPartAtom, part)
	}

	const completeTool = (id: string, name?: string) => {
		const existing = tools.get(id)
		const end = Date.now()
		const start = existing?.state.status === "running" ? existing.state.time.start : end
		const input = existing?.state.input ?? {}
		const part: ToolPart = {
			id: existing?.id ?? `${assistantId}-tool-${id}`,
			sessionID: args.uiSessionId,
			messageID: assistantId,
			type: "tool",
			callID: id,
			tool: name ?? existing?.tool ?? "tool",
			state: {
				status: "completed",
				input,
				output: outputs.get(id) ?? "",
				title: name ?? existing?.tool ?? "tool",
				metadata: {},
				time: { start, end },
			},
		}
		tools.set(id, part)
		appStore.set(upsertPartAtom, part)
	}

	const handleEvent = ({ event }: SequencedAgentEvent) => {
		switch (event.type) {
			case "message.delta":
				appendText(String(event.text ?? ""))
				break
			case "reasoning.delta":
				appendText(String(event.text ?? ""), true)
				break
			case "tool.started": {
				const id = String(event.id)
				const input =
					event.input && typeof event.input === "object"
						? (event.input as Record<string, unknown>)
						: {}
				upsertRunningTool(id, String(event.name ?? "tool"), input)
				break
			}
			case "tool.output": {
				const id = String(event.id)
				outputs.set(id, (outputs.get(id) ?? "") + stringify(event.output))
				const existing = tools.get(id)
				upsertRunningTool(id, existing?.tool ?? "tool", existing?.state.input ?? {})
				break
			}
			case "tool.completed":
				completeTool(String(event.id), String(event.name ?? "tool"))
				break
			case "terminal.output": {
				const id = `terminal-${String(event.processId)}`
				outputs.set(id, (outputs.get(id) ?? "") + String(event.data ?? ""))
				upsertRunningTool(id, "bash", { command: `process ${String(event.processId)}` })
				break
			}
			case "file.changed": {
				const id = `file-${crypto.randomUUID()}`
				const path = String(event.path ?? "")
				outputs.set(id, path)
				upsertRunningTool(id, "file.changed", { path })
				completeTool(id, "File changed")
				break
			}
			case "question": {
				sawQuestion = true
				const prompt = String(event.prompt ?? "The agent is waiting for input.")
				addUnifiedQuestion(args.uiSessionId, String(event.id ?? crypto.randomUUID()), prompt)
				setBusy(args.uiSessionId, false)
				break
			}
			case "state.changed": {
				finalState = String(event.state)
				if (finalState === "waiting_input") {
					if (!sawQuestion) {
						sawQuestion = true
						addUnifiedQuestion(
							args.uiSessionId,
							`unified-waiting-${crypto.randomUUID()}`,
							"The agent is waiting for additional input.",
						)
					}
					setBusy(args.uiSessionId, false)
				} else {
					setBusy(args.uiSessionId, finalState === "starting" || finalState === "running")
				}
				break
			}
			case "run.failed":
			case "error":
				setError(args.uiSessionId, String(event.message ?? "AgentDriver run failed"))
				break
		}
	}

	try {
		await runAgentMessage(agentSessionId, args.message, handleEvent, controller.signal)
	} catch (error) {
		if (!(error instanceof DOMException && error.name === "AbortError")) {
			setError(args.uiSessionId, error instanceof Error ? error.message : String(error))
			throw error
		}
	} finally {
		const current = activeRuns.get(args.uiSessionId)
		if (current?.controller === controller) activeRuns.delete(args.uiSessionId)
		for (const [id, part] of tools) {
			if (part.state.status === "running") completeTool(id)
		}
		assistant = { ...assistant, time: { ...assistant.time, completed: Date.now() } }
		appStore.set(upsertMessageAtom, assistant)
		setBusy(args.uiSessionId, false)
	}

	return agentSessionId
}

export async function interruptUnifiedAgentPrompt(
	uiSessionId: string,
	agentSessionId?: string,
): Promise<boolean> {
	const active = activeRuns.get(uiSessionId)
	const targetSessionId = active?.agentSessionId ?? agentSessionId
	if (!targetSessionId) return false
	try {
		await interruptUnifiedAgentSession(targetSessionId)
	} finally {
		active?.controller.abort()
		activeRuns.delete(uiSessionId)
		setBusy(uiSessionId, false)
	}
	return true
}
