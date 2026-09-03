import { describe, expect, test } from "bun:test"
import { createOpenCodeEventBridge } from "./opencode-event-bridge"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	needle: string,
	timeoutMs = 1_000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs
	let output = ""
	while (Date.now() < deadline) {
		const remaining = Math.max(1, deadline - Date.now())
		const result = await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error(`Timed out waiting for ${needle}: ${output}`)),
					remaining,
				),
			),
		])
		if (result.done) break
		output += decoder.decode(result.value, { stream: true })
		if (output.includes(needle)) return output
	}
	throw new Error(`Timed out waiting for ${needle}: ${output}`)
}

describe("OpenCode event bridge", () => {
	test("waits through idle shutdown and reattaches without restarting OpenCode itself", async () => {
		let currentUrl: string | null = null
		let ensureCalls = 0
		let fetchCalls = 0

		const bridge = createOpenCodeEventBridge({
			ensureServerUrl: async () => {
				ensureCalls++
				currentUrl = "http://opencode.test"
				return currentUrl
			},
			getServerUrl: () => currentUrl,
			fetchImpl: async () => {
				fetchCalls++
				if (fetchCalls === 1) {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(encoder.encode("data: first\n\n"))
								currentUrl = null
								controller.close()
							},
						}),
						{ status: 200 },
					)
				}
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode("data: second\n\n"))
						},
					}),
					{ status: 200 },
				)
			},
			retryDelayMs: 10,
			keepAliveMs: 25,
		})

		const reader = bridge.getReader()
		expect(await readUntil(reader, "data: first")).toContain("data: first")
		expect(await readUntil(reader, ": eigent-opencode-idle")).toContain(": eigent-opencode-idle")
		expect(ensureCalls).toBe(1)
		expect(fetchCalls).toBe(1)

		// A real API request is what makes the managed runtime visible again.
		currentUrl = "http://opencode.test"
		expect(await readUntil(reader, "data: second")).toContain("data: second")
		expect(ensureCalls).toBe(1)
		expect(fetchCalls).toBe(2)
		await reader.cancel("test complete")
	})

	test("does not auto-restart after a pre-existing runtime idles out", async () => {
		let currentUrl: string | null = "http://opencode.test"
		let ensureCalls = 0
		let fetchCalls = 0

		const bridge = createOpenCodeEventBridge({
			ensureServerUrl: async () => {
				ensureCalls++
				currentUrl = "http://opencode.test"
				return currentUrl
			},
			getServerUrl: () => currentUrl,
			fetchImpl: async () => {
				fetchCalls++
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(encoder.encode("data: existing\n\n"))
							currentUrl = null
							controller.close()
						},
					}),
					{ status: 200 },
				)
			},
			retryDelayMs: 10,
			keepAliveMs: 25,
		})

		const reader = bridge.getReader()
		expect(await readUntil(reader, "data: existing")).toContain("data: existing")
		expect(await readUntil(reader, ": eigent-opencode-idle")).toContain(": eigent-opencode-idle")
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(ensureCalls).toBe(0)
		expect(fetchCalls).toBe(1)
		await reader.cancel("test complete")
	})
})
