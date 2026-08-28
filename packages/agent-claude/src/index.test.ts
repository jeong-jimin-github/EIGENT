import { describe, expect, test } from "bun:test"
import { mapClaudeEvent } from "./index"

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
