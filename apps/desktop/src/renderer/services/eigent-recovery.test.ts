import { describe, expect, test } from "bun:test"
import { parseSSEBlock, reconnectDelay, runAgentMessage } from "./eigent-recovery"

describe("EIGENT browser recovery helpers", () => {
	test("uses capped exponential reconnect backoff", () => {
		expect(reconnectDelay(0, { jitter: 0 })).toBe(500)
		expect(reconnectDelay(1, { jitter: 0 })).toBe(1_000)
		expect(reconnectDelay(5, { jitter: 0 })).toBe(16_000)
		expect(reconnectDelay(6, { jitter: 0 })).toBe(30_000)
		expect(reconnectDelay(20, { jitter: 0 })).toBe(30_000)
	})

	test("keeps jitter inside the configured retry window", () => {
		expect(reconnectDelay(2, { random: () => 0, jitter: 0.2 })).toBe(1_600)
		expect(reconnectDelay(2, { random: () => 1, jitter: 0.2 })).toBe(2_400)
	})

	test("parses event ids used as reconnect cursors", () => {
		expect(
			parseSSEBlock('id: 42\nevent: agent\ndata: {"type":"message.delta",\ndata: "text":"ok"}'),
		).toEqual({
			id: "42",
			event: "agent",
			data: '{"type":"message.delta",\n"text":"ok"}',
		})
	})

	test("ignores comment-only SSE heartbeat blocks", () => {
		expect(parseSSEBlock(": keep-alive")).toBeNull()
	})

	test("cancels an infinite replay stream after the matching run terminal event", async () => {
		const originalFetch = globalThis.fetch
		const encoder = new TextEncoder()
		const requestId = "request-reconnect-test"
		const seen: number[] = []
		let calls = 0
		let replayCancelled = false

		globalThis.fetch = (async () => {
			calls += 1
			if (calls === 1) {
				return new Response(
					`id: 1\nevent: agent\ndata: ${JSON.stringify({ type: "run.requested", requestId, message: "hello" })}\n\n`,
					{ status: 200 },
				)
			}
			if (calls === 2) {
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								encoder.encode(
									`id: 2\nevent: agent\ndata: ${JSON.stringify({ type: "run.completed", requestId })}\n\n`,
								),
							)
						},
						cancel() {
							replayCancelled = true
						},
					}),
					{ status: 200 },
				)
			}
			throw new Error("unexpected fetch")
		}) as unknown as typeof fetch

		try {
			const result = await runAgentMessage(
				"session-reconnect",
				"hello",
				(item) => seen.push(item.sequence),
				new AbortController().signal,
				requestId,
			)
			expect(result).toEqual({ requestId, lastSequence: 2 })
			expect(seen).toEqual([1, 2])
			expect(calls).toBe(2)
			expect(replayCancelled).toBe(true)
		} finally {
			globalThis.fetch = originalFetch
		}
	})

})
