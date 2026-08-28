import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AgentEvent, AgentSession } from "@eigent/agent-core"
import {
	type AgentRunBackend,
	AgentRunCoordinator,
	isRunTerminalEvent,
} from "./agent-run-coordinator"
import { StateStore } from "./state-store"

const tempDirs: string[] = []
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeSession(state: AgentSession["state"] = "starting"): AgentSession {
	return {
		id: "session-runner",
		provider: "codex",
		model: "test-model",
		workspace: "/tmp/eigent-runner",
		state,
		createdAt: 100,
	}
}

class FakeBackend implements AgentRunBackend {
	calls = 0

	constructor(
		private readonly store: StateStore,
		private session: AgentSession,
	) {}

	getSession(id: string): AgentSession | null {
		if (id !== this.session.id) return null
		return { ...this.session }
	}

	async *events(id: string, message: string): AsyncIterable<AgentEvent> {
		this.calls += 1
		this.session.state = "running"
		const running = { type: "state.changed", state: "running" } as const
		this.store.appendAgentEvent(id, running)
		yield running

		await new Promise((resolve) => setTimeout(resolve, 10))
		const delta = { type: "message.delta", text: `echo:${message}` } as const
		this.store.appendAgentEvent(id, delta)
		yield delta

		this.session.state = "completed"
		const completed = { type: "state.changed", state: "completed" } as const
		this.store.appendAgentEvent(id, completed)
		yield completed
	}
}

class FailingBackend implements AgentRunBackend {
	constructor(private readonly session: AgentSession) {}

	getSession(id: string): AgentSession | null {
		return id === this.session.id ? { ...this.session } : null
	}

	async *events(): AsyncIterable<AgentEvent> {
		yield* [] as AgentEvent[]
		throw new Error("provider exploded")
	}
}

async function waitForTerminalRun(store: StateStore, sessionId: string, requestId: string) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const event = store
			.listAgentEvents(sessionId)
			.find((item) => isRunTerminalEvent(item.event) && item.event.requestId === requestId)
		if (event) return event
		await new Promise((resolve) => setTimeout(resolve, 2))
	}
	throw new Error("run did not finish")
}

describe("AgentRunCoordinator", () => {
	test("keeps a run alive independently and deduplicates the same request id", async () => {
		const store = new StateStore(":memory:")
		try {
			const session = makeSession()
			store.saveAgentSnapshot({ session })
			const backend = new FakeBackend(store, session)
			const coordinator = new AgentRunCoordinator(backend, store)

			const first = coordinator.start(session.id, "hello", "request-1")
			const duplicate = coordinator.start(session.id, "hello", "request-1")
			expect(first.started).toBe(true)
			expect(duplicate.started).toBe(false)
			expect(duplicate.startSequence).toBe(first.startSequence)

			await waitForTerminalRun(store, session.id, "request-1")
			expect(backend.calls).toBe(1)
			expect(
				store.listAgentEvents(session.id).filter((item) => item.event.type === "run.requested"),
			).toHaveLength(1)
			expect(
				store.listAgentEvents(session.id).some((item) => item.event.type === "message.delta"),
			).toBe(true)
		} finally {
			store.close()
		}
	})

	test("does not replay an already persisted request after coordinator recreation", async () => {
		const store = new StateStore(":memory:")
		try {
			const session = makeSession()
			store.saveAgentSnapshot({ session })
			const firstBackend = new FakeBackend(store, session)
			const first = new AgentRunCoordinator(firstBackend, store)
			first.start(session.id, "once", "stable-request")
			await waitForTerminalRun(store, session.id, "stable-request")

			const secondBackend = new FakeBackend(store, makeSession("completed"))
			const second = new AgentRunCoordinator(secondBackend, store)
			const recovered = second.start(session.id, "once", "stable-request")
			expect(recovered.started).toBe(false)
			expect(secondBackend.calls).toBe(0)
		} finally {
			store.close()
		}
	})

	test("persists failed session state when the provider throws outside normalized events", async () => {
		const store = new StateStore(":memory:")
		try {
			const session = makeSession("running")
			store.saveAgentSnapshot({ session })
			const coordinator = new AgentRunCoordinator(new FailingBackend(session), store)
			coordinator.start(session.id, "explode", "request-failed")
			const terminal = await waitForTerminalRun(store, session.id, "request-failed")
			expect(terminal.event.type).toBe("run.failed")
			expect(store.getAgentSession(session.id)?.session.state).toBe("failed")
			expect(store.listAgentEvents(session.id).some((item) => item.event.type === "error")).toBe(
				true,
			)
		} finally {
			store.close()
		}
	})

	test("a request accepted before server restart is not duplicated after restart", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "eigent-run-restart-"))
		tempDirs.push(dir)
		const filename = path.join(dir, "state.db")

		const first = new StateStore(filename)
		const session = makeSession("running")
		first.saveAgentSnapshot({ session })
		first.appendAgentEvent(session.id, {
			type: "run.requested",
			requestId: "restart-request",
			message: "do not duplicate",
		})
		first.close()

		const second = new StateStore(filename)
		try {
			expect(second.markActiveAgentSessionsInterrupted()).toBe(1)
			const restored = second.getAgentSession(session.id)?.session
			expect(restored?.state).toBe("interrupted")
			const backend = new FakeBackend(second, restored!)
			const coordinator = new AgentRunCoordinator(backend, second)
			const run = coordinator.start(session.id, "do not duplicate", "restart-request")
			expect(run.started).toBe(false)
			expect(backend.calls).toBe(0)
		} finally {
			second.close()
		}
	})
})
