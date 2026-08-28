import { describe, expect, test } from "bun:test"

process.env.EIGENT_STATE_DB = ":memory:"

describe("recovery route", () => {
	test("rehydrates durable workspace state without creating duplicate identities", async () => {
		const [{ stateStore }, { default: recovery }] = await Promise.all([
			import("../services/state"),
			import("./recovery"),
		])
		const workspace = `/tmp/eigent-recovery-${Date.now()}`
		const task = stateStore.createTask(workspace, "Recover me")
		stateStore.saveAgentSnapshot({
			session: {
				id: `session-${Date.now()}`,
				provider: "codex",
				model: "test-model",
				workspace,
				taskId: task.id,
				state: "completed",
				createdAt: Date.now(),
			},
			driverState: { providerSessionId: "thread-recovery" },
		})
		const session = stateStore.listAgentSessions(workspace)[0]!
		stateStore.appendAgentEvent(session.session.id, { type: "message.delta", text: "persisted" })
		stateStore.saveManagedProcess({
			id: `process-${Date.now()}`,
			taskId: task.id,
			command: "echo persisted",
			cwd: workspace,
			pid: null,
			state: "exited",
			exitCode: 0,
			startedAt: Date.now(),
			endedAt: Date.now(),
			output: "persisted\n",
		})

		const url = `http://localhost/?${new URLSearchParams({ workspace })}`
		const firstResponse = await recovery.request(url)
		const secondResponse = await recovery.request(url)
		expect(firstResponse.status).toBe(200)
		expect(secondResponse.status).toBe(200)

		const first = (await firstResponse.json()) as {
			tasks: Array<{ id: string }>
			sessions: Array<{ session: { id: string }; lastSequence: number }>
			processes: Array<{ id: string; state: string }>
		}
		const second = (await secondResponse.json()) as typeof first
		expect(first.tasks.map((item) => item.id)).toEqual(second.tasks.map((item) => item.id))
		expect(first.sessions.map((item) => item.session.id)).toEqual(
			second.sessions.map((item) => item.session.id),
		)
		expect(first.processes.map((item) => item.id)).toEqual(second.processes.map((item) => item.id))
		expect(first.sessions[0]?.lastSequence).toBe(1)
		expect(first.processes[0]?.state).toBe("exited")
	})
})
