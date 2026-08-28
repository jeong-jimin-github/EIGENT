/** Browser recovery primitives for durable EIGENT task/session/process state. */

export type RecoverySessionState =
	| "starting"
	| "running"
	| "waiting_input"
	| "completed"
	| "failed"
	| "interrupted"

export interface RecoveryTask {
	id: string
	workspace: string
	title: string
	state: RecoverySessionState | "pending"
	createdAt: number
	updatedAt: number
}

export interface RecoveryAgentSession {
	id: string
	provider: "codex" | "claude" | "openai" | "anthropic" | "opencode" | "antigravity"
	model: string
	workspace: string
	taskId?: string
	state: RecoverySessionState
	createdAt: number
}

export interface RecoverySession {
	session: RecoveryAgentSession
	lastSequence: number
	activeRequestId: string | null
	running: boolean
}

export interface RecoveryProcess {
	id: string
	command: string
	cwd: string
	taskId?: string
	pid: number | null
	state: "running" | "exited" | "killed" | "failed" | "orphaned"
	exitCode: number | null
	startedAt: number
	endedAt: number | null
	output: string
}

export interface RecoverySnapshot {
	schemaVersion: number
	generatedAt: number
	workspace: string
	tasks: RecoveryTask[]
	sessions: RecoverySession[]
	processes: RecoveryProcess[]
}

export interface AgentWireEvent {
	type: string
	[key: string]: unknown
}

export interface SequencedAgentEvent {
	sequence: number
	event: AgentWireEvent
}

interface SSEFrame {
	id?: string
	event?: string
	data: string
}

export function reconnectDelay(
	attempt: number,
	options: { baseMs?: number; maxMs?: number; jitter?: number; random?: () => number } = {},
): number {
	const baseMs = options.baseMs ?? 500
	const maxMs = options.maxMs ?? 30_000
	const jitter = options.jitter ?? 0.2
	const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt))
	if (jitter <= 0) return raw
	const random = options.random ?? Math.random
	const spread = raw * jitter
	return Math.max(0, Math.round(raw - spread + random() * spread * 2))
}

function abortError(): DOMException {
	return new DOMException("The operation was aborted", "AbortError")
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw abortError()
	await new Promise<void>((resolve, reject) => {
		const finish = () => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}
		const timer = setTimeout(finish, ms)
		const onAbort = () => {
			clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
			reject(abortError())
		}
		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
	const response = await fetch(url, { signal })
	const data = (await response.json()) as T & { error?: unknown }
	if (!response.ok) {
		throw new Error(typeof data.error === "string" ? data.error : `${response.status} ${response.statusText}`)
	}
	return data
}

export async function fetchRecoverySnapshot(
	workspace: string,
	signal?: AbortSignal,
): Promise<RecoverySnapshot> {
	const query = new URLSearchParams({ workspace })
	return fetchJson<RecoverySnapshot>(`/api/recovery?${query}`, signal)
}

export async function watchRecoverySnapshots(
	workspace: string,
	onSnapshot: (snapshot: RecoverySnapshot) => void,
	onError: (error: unknown) => void,
	signal: AbortSignal,
	pollMs = 1_000,
): Promise<void> {
	let failures = 0
	while (!signal.aborted) {
		try {
			onSnapshot(await fetchRecoverySnapshot(workspace, signal))
			failures = 0
			await sleep(pollMs, signal)
		} catch (err) {
			if (signal.aborted) return
			onError(err)
			const delay = reconnectDelay(failures)
			failures += 1
			await sleep(delay, signal).catch(() => undefined)
		}
	}
}

export function parseSSEBlock(block: string): SSEFrame | null {
	let id: string | undefined
	let event: string | undefined
	const data: string[] = []
	for (const rawLine of block.split(/\r?\n/)) {
		if (!rawLine || rawLine.startsWith(":")) continue
		const separator = rawLine.indexOf(":")
		const field = separator >= 0 ? rawLine.slice(0, separator) : rawLine
		let value = separator >= 0 ? rawLine.slice(separator + 1) : ""
		if (value.startsWith(" ")) value = value.slice(1)
		if (field === "id") id = value
		else if (field === "event") event = value
		else if (field === "data") data.push(value)
	}
	if (!id && !event && data.length === 0) return null
	return { id, event, data: data.join("\n") }
}

async function consumeSSE(
	response: Response,
	onFrame: (frame: SSEFrame) => boolean | void,
	signal?: AbortSignal,
): Promise<void> {
	if (!response.ok || !response.body) {
		const text = await response.text().catch(() => "")
		throw new Error(text || `${response.status} ${response.statusText}`)
	}
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let buffer = ""
	while (!signal?.aborted) {
		const { done, value } = await reader.read()
		if (done) break
		buffer += decoder.decode(value, { stream: true })
		const blocks = buffer.split(/\r?\n\r?\n/)
		buffer = blocks.pop() ?? ""
		for (const block of blocks) {
			const frame = parseSSEBlock(block)
			if (frame && onFrame(frame) === true) {
				await reader.cancel()
				return
			}
		}
	}
	buffer += decoder.decode()
	if (buffer.trim()) {
		const frame = parseSSEBlock(buffer)
		if (frame) onFrame(frame)
	}
}

export async function streamAgentEvents(
	sessionId: string,
	afterSequence: number,
	onEvent: (item: SequencedAgentEvent) => void,
	signal: AbortSignal,
): Promise<void> {
	let cursor = Math.max(0, afterSequence)
	let failures = 0
	while (!signal.aborted) {
		try {
			const query = new URLSearchParams({ after: String(cursor) })
			const response = await fetch(`/api/agents/sessions/${encodeURIComponent(sessionId)}/stream?${query}`, {
				signal,
			})
			await consumeSSE(
				response,
				(frame) => {
					if (frame.event !== "agent" || !frame.id || !frame.data) return
					const sequence = Number(frame.id)
					if (!Number.isInteger(sequence) || sequence <= cursor) return
					cursor = sequence
					onEvent({ sequence, event: JSON.parse(frame.data) as AgentWireEvent })
				},
				signal,
			)
			failures = 0
			if (!signal.aborted) await sleep(reconnectDelay(0), signal)
		} catch (err) {
			if (signal.aborted) return
			await sleep(reconnectDelay(failures), signal).catch(() => undefined)
			failures += 1
		}
	}
}

export async function runAgentMessage(
	sessionId: string,
	message: string,
	onEvent: (item: SequencedAgentEvent) => void,
	signal: AbortSignal,
	requestId: string = crypto.randomUUID(),
): Promise<{ requestId: string; lastSequence: number }> {
	let cursor = 0
	let accepted = false
	let failures = 0
	let finished = false

	while (!signal.aborted && !finished) {
		try {
			const response = accepted
				? await fetch(
						`/api/agents/sessions/${encodeURIComponent(sessionId)}/stream?${new URLSearchParams({ after: String(cursor) })}`,
						{ signal },
					)
				: await fetch(`/api/agents/sessions/${encodeURIComponent(sessionId)}/messages`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ message, requestId }),
						signal,
					})

			await consumeSSE(
				response,
				(frame) => {
					if (frame.event === "done") {
						finished = true
						return true
					}
					if (frame.event !== "agent" || !frame.id || !frame.data) return
					const sequence = Number(frame.id)
					if (!Number.isInteger(sequence) || sequence <= cursor) return
					const event = JSON.parse(frame.data) as AgentWireEvent
					cursor = sequence
					if (event.type === "run.requested" && event.requestId === requestId) accepted = true
					const terminal =
						["run.completed", "run.failed", "run.interrupted"].includes(event.type) &&
						event.requestId === requestId
					if (terminal) finished = true
					onEvent({ sequence, event })
					return terminal
				},
				signal,
			)
			failures = 0
			if (!finished) await sleep(reconnectDelay(failures), signal)
		} catch (err) {
			if (signal.aborted) throw abortError()
			await sleep(reconnectDelay(failures), signal)
			failures += 1
		}
	}

	if (signal.aborted) throw abortError()
	return { requestId, lastSequence: cursor }
}
