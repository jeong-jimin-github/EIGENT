import { describe, expect, test } from "bun:test"
import type { PersistedUnifiedAgentEvent } from "./eigent-agents"
import { replayUnifiedAgentRuns } from "./eigent-history"

function item(sequence: number, createdAt: number, event: Record<string, unknown>) {
	return { sequence, createdAt, event } as PersistedUnifiedAgentEvent
}

describe("unified agent history replay", () => {
	test("reconstructs message, reasoning, tools and completion", () => {
		const runs = replayUnifiedAgentRuns([
			item(1, 1000, { type: "run.requested", requestId: "r1", message: "fix it" }),
			item(2, 1010, { type: "state.changed", state: "running" }),
			item(3, 1020, { type: "reasoning.delta", text: "think" }),
			item(4, 1030, { type: "tool.started", id: "t1", name: "read", input: { path: "a.ts" } }),
			item(5, 1040, { type: "tool.output", id: "t1", output: "hello" }),
			item(6, 1050, { type: "tool.completed", id: "t1", name: "read" }),
			item(7, 1060, { type: "message.delta", text: "done" }),
			item(8, 1070, { type: "run.completed", requestId: "r1" }),
		])
		expect(runs).toHaveLength(1)
		expect(runs[0]).toMatchObject({
			requestId: "r1",
			message: "fix it",
			text: "done",
			reasoning: "think",
			completedAt: 1070,
			waitingInput: false,
		})
		expect(runs[0].tools).toEqual([
			{
				id: "t1",
				name: "read",
				input: { path: "a.ts" },
				output: "hello",
				startedAt: 1030,
				completedAt: 1050,
			},
		])
	})

	test("preserves waiting-input after coordinator completion and clears it on the next run", () => {
		const runs = replayUnifiedAgentRuns([
			item(1, 1000, { type: "run.requested", requestId: "r1", message: "start" }),
			item(2, 1010, { type: "state.changed", state: "waiting_input" }),
			item(3, 1020, { type: "run.completed", requestId: "r1" }),
			item(4, 1030, { type: "run.requested", requestId: "r2", message: "answer" }),
			item(5, 1040, { type: "state.changed", state: "running" }),
			item(6, 1050, { type: "message.delta", text: "continued" }),
			item(7, 1060, { type: "run.completed", requestId: "r2" }),
		])
		expect(runs[0].waitingInput).toBe(true)
		expect(runs[1].waitingInput).toBe(false)
		expect(runs[1].text).toBe("continued")
	})
})
