import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AgentSessionSnapshot } from "@eigent/agent-core"
import { StateStore } from "./state-store"

function sessionSnapshot(state: AgentSessionSnapshot["session"]["state"] = "running") {
	return {
		session: {
			id: "session-1",
			provider: "codex" as const,
			model: "test-model",
			workspace: "/tmp/eigent-test",
			state,
			createdAt: 100,
		},
		driverState: { providerSessionId: "thread-1", yolo: true },
	} satisfies AgentSessionSnapshot
}

const tempDirs: string[] = []
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("StateStore", () => {
	test("migrates schema and round-trips agent sessions and events", () => {
		const store = new StateStore(":memory:")
		try {
			expect(store.getSchemaVersion()).toBe(1)
			store.saveAgentSnapshot(sessionSnapshot())
			store.appendAgentEvent("session-1", { type: "message.delta", text: "hello" })
			store.appendAgentEvent("session-1", { type: "state.changed", state: "completed" })

			const restored = store.getAgentSession("session-1")
			expect(restored?.session.state).toBe("completed")
			expect(restored?.driverState).toEqual({ providerSessionId: "thread-1", yolo: true })
			expect(store.listAgentEvents("session-1").map((item) => item.sequence)).toEqual([1, 2])
			expect(store.listAgentEvents("session-1", 1)).toHaveLength(1)
		} finally {
			store.close()
		}
	})

	test("persists task lifecycle and links agent state transitions", () => {
		const store = new StateStore(":memory:")
		try {
			const task = store.createTask("/tmp/eigent-test", "Implement persistence")
			expect(task.state).toBe("pending")
			store.saveAgentSnapshot({
				...sessionSnapshot(),
				session: { ...sessionSnapshot().session, taskId: task.id },
			})
			store.appendAgentEvent("session-1", { type: "state.changed", state: "running" })
			expect(store.getTask(task.id)?.state).toBe("running")
			store.appendAgentEvent("session-1", { type: "state.changed", state: "completed" })
			expect(store.getTask(task.id)?.state).toBe("completed")
			expect(store.listTasks("/tmp/eigent-test")).toHaveLength(1)
		} finally {
			store.close()
		}
	})

	test("recovers durable state after closing and reopening the database", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "eigent-state-"))
		tempDirs.push(dir)
		const filename = path.join(dir, "state.db")
		const first = new StateStore(filename)
		const task = first.createTask("/tmp/eigent-test", "Restart recovery")
		first.saveAgentSnapshot({
			...sessionSnapshot(),
			session: { ...sessionSnapshot().session, taskId: task.id },
		})
		first.saveManagedProcess({
			id: "process-restart",
			taskId: task.id,
			command: "sleep 60",
			cwd: "/tmp/eigent-test",
			pid: 42,
			state: "running",
			exitCode: null,
			startedAt: 100,
			endedAt: null,
			output: "",
		})
		first.close()

		const second = new StateStore(filename)
		try {
			expect(second.markActiveAgentSessionsInterrupted()).toBe(1)
			expect(second.markRunningProcessesOrphaned()).toBe(1)
			expect(second.getAgentSession("session-1")?.session.taskId).toBe(task.id)
			expect(second.getTask(task.id)?.state).toBe("interrupted")
			expect(second.listManagedProcesses()[0]?.taskId).toBe(task.id)
			expect(second.listManagedProcesses()[0]?.state).toBe("orphaned")
		} finally {
			second.close()
		}
	})

	test("marks active sessions interrupted during restart reconciliation", () => {
		const store = new StateStore(":memory:")
		try {
			store.saveAgentSnapshot(sessionSnapshot("waiting_input"))
			expect(store.markActiveAgentSessionsInterrupted()).toBe(1)
			expect(store.getAgentSession("session-1")?.session.state).toBe("interrupted")
			expect(store.listAgentEvents("session-1").at(-1)?.event).toEqual({
				type: "state.changed",
				state: "interrupted",
			})
			expect(store.markActiveAgentSessionsInterrupted()).toBe(0)
		} finally {
			store.close()
		}
	})

	test("marks persisted running processes orphaned after restart", () => {
		const store = new StateStore(":memory:")
		try {
			store.saveManagedProcess({
				id: "process-1",
				command: "sleep 60",
				cwd: "/tmp/eigent-test",
				pid: 123,
				state: "running",
				exitCode: null,
				startedAt: 100,
				endedAt: null,
				output: "started\n",
			})

			expect(store.markRunningProcessesOrphaned()).toBe(1)
			const restored = store.listManagedProcesses()[0]
			expect(restored?.state).toBe("orphaned")
			expect(restored?.pid).toBeNull()
			expect(restored?.output).toContain("server restart")
		} finally {
			store.close()
		}
	})
})
