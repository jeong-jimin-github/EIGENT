import { describe, expect, test } from "bun:test"
import {
	buildClaudeCommand,
	claudeSubscriptionEnvironment,
	claudeSubscriptionOverrides,
	formatClaudeFailure,
	mapClaudeEvent,
} from "./index"

describe("Claude event mapping", () => {
	test("maps normal stream text deltas", () => {
		expect(
			mapClaudeEvent({
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
			}),
		).toEqual([{ type: "message.delta", text: "hello" }])
	})

	test("maps successful result envelopes that carry API errors", () => {
		expect(
			mapClaudeEvent({
				type: "result",
				subtype: "success",
				is_error: true,
				api_error_status: 403,
				result: "Failed to authenticate. API Error: 403 quota exhausted",
			}),
		).toEqual([
			{
				type: "error",
				message: "Failed to authenticate. API Error: 403 quota exhausted",
				recoverable: true,
			},
		])
	})
})

describe("Claude subscription execution", () => {
	test("removes API/provider overrides while preserving ordinary environment", () => {
		const source = {
			PATH: "bin",
			KEEP_ME: "yes",
			ANTHROPIC_API_KEY: "api-key",
			ANTHROPIC_AUTH_TOKEN: "oauth-looking-proxy-token",
			ANTHROPIC_BASE_URL: "https://proxy.invalid",
			CLAUDE_CODE_USE_OPENAI: "1",
			CLAUDE_CODE_USE_BEDROCK: "1",
		} satisfies NodeJS.ProcessEnv

		expect(claudeSubscriptionEnvironment(source)).toEqual({ PATH: "bin", KEEP_ME: "yes" })
		expect(claudeSubscriptionOverrides(source)).toEqual([
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"CLAUDE_CODE_USE_BEDROCK",
			"CLAUDE_CODE_USE_OPENAI",
		])
	})

	test("uses verified stream-json flags for initial and resumed turns", () => {
		expect(
			buildClaudeCommand({
				executable: "claude",
				model: "sonnet",
				yolo: true,
				effort: "high",
				sessionId: "session-1",
				started: false,
				systemPrompt: "system",
				message: "hello",
			}),
		).toEqual([
			"claude",
			"-p",
			"--output-format",
			"stream-json",
			"--verbose",
			"--include-partial-messages",
			"--model",
			"sonnet",
			"--permission-mode",
			"bypassPermissions",
			"--effort",
			"high",
			"--session-id",
			"session-1",
			"--append-system-prompt",
			"system",
			"hello",
		])

		const resumed = buildClaudeCommand({
			executable: "claude",
			model: "sonnet",
			yolo: true,
			sessionId: "session-1",
			started: true,
			systemPrompt: "must-not-repeat",
			message: "continue",
		})
		expect(resumed).toContain("--resume")
		expect(resumed).not.toContain("--session-id")
		expect(resumed).not.toContain("--append-system-prompt")
	})

	test("retains provider error, exit code, and stderr diagnostics", () => {
		expect(formatClaudeFailure("provider failed", 1, "stderr detail")).toBe(
			"provider failed\nClaude exit code: 1\nClaude stderr: stderr detail",
		)
	})
})

describe("Claude session lifecycle", () => {
	test("interrupts and resumes a session without losing resume state", async () => {
		const { ClaudeDriver } = await import("./index")
		const driver = new ClaudeDriver({ models: ["sonnet"] })
		const session = await driver.startSession({
			workspace: process.cwd(),
			model: "sonnet",
			yolo: true,
		})

		await driver.interrupt(session.id)
		expect(driver.snapshotSession(session.id)?.session.state).toBe("interrupted")

		await driver.resume(session.id)
		expect(driver.snapshotSession(session.id)?.session.state).toBe("running")
	})
})
