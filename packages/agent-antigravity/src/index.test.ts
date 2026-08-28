import { describe, expect, test } from "bun:test"
import { antigravityEvent, parseAvailableModels } from "./index"

describe("Antigravity event mapping", () => {
	test("maps assistant text", () => {
		expect(
			antigravityEvent({
				event: "step_update",
				step_update: {
					conversation_id: "c1",
					step_index: 1,
					state: "ACTIVE",
					step_type: "agent_response",
					text_delta: "hello",
				},
			}),
		).toEqual([{ type: "message.delta", text: "hello" }])
	})

	test("maps tool lifecycle", () => {
		expect(
			antigravityEvent({
				event: "step_update",
				step_update: {
					conversation_id: "c1",
					step_index: 2,
					state: "ACTIVE",
					step_type: "tool",
					tool_name: "run_command",
					tool_info: { parameters: { CommandLine: "bun test" } },
				},
			}),
		).toEqual([
			{ type: "tool.started", id: "c1:2", name: "run_command", input: { CommandLine: "bun test" } },
		])
		expect(
			antigravityEvent({
				event: "step_update",
				step_update: {
					conversation_id: "c1",
					step_index: 2,
					state: "DONE",
					step_type: "tool",
					tool_name: "run_command",
					tool_info: { output: "ok" },
				},
			}),
		).toEqual([
			{ type: "tool.output", id: "c1:2", output: "ok" },
			{ type: "tool.completed", id: "c1:2", name: "run_command" },
		])
	})

	test("preserves conversation id across persistence snapshots", async () => {
		const driver = new (await import("./index")).AntigravityDriver({
			models: ["Gemini 3.7 Flash (Low)"],
		})
		const session = await driver.startSession({
			workspace: process.cwd(),
			model: "Gemini 3.7 Flash (Low)",
			yolo: true,
		})
		const snapshot = driver.snapshotSession(session.id)
		expect(snapshot?.session.id).toBe(session.id)
		expect(snapshot?.driverState).toEqual({
			conversationId: undefined,
			yolo: true,
			systemPrompt: undefined,
		})
		const restored = new (await import("./index")).AntigravityDriver({
			models: ["Gemini 3.7 Flash (Low)"],
		})
		restored.restoreSession({
			session,
			driverState: { conversationId: "conversation-27", yolo: true },
		})
		expect(restored.snapshotSession(session.id)?.driverState).toEqual({
			conversationId: "conversation-27",
			yolo: true,
			systemPrompt: undefined,
		})
	})

	test("maps result states", () => {
		expect(antigravityEvent({ event: "result", result: { status: "SUCCESS" } })).toEqual([
			{ type: "state.changed", state: "completed" },
		])
		expect(
			antigravityEvent({ event: "result", result: { status: "ERROR", error: "bad" } }),
		).toEqual([
			{ type: "error", message: "bad", recoverable: true },
			{ type: "state.changed", state: "failed" },
		])
	})
})

describe("Antigravity model discovery", () => {
	test("parses models from JSON error envelope", () => {
		const raw = JSON.stringify({
			error:
				"invalid model\nAvailable models:\n  Gemini 3.7 Flash (High)\n  Claude Sonnet 4.6 (Thinking)\n  GPT-OSS 120B (Medium)",
		})
		expect(parseAvailableModels(raw)).toEqual([
			"Gemini 3.7 Flash (High)",
			"Claude Sonnet 4.6 (Thinking)",
			"GPT-OSS 120B (Medium)",
		])
	})
})
