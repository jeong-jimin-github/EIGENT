import { afterEach, describe, expect, test } from "bun:test"
import { hasActiveOpenCodeSessions, resolveOpenCodeIdleTimeoutMs } from "./server-manager"

const originalIdleTimeout = process.env.EIGENT_OPENCODE_IDLE_TIMEOUT_MS
const originalLowMemory = process.env.EIGENT_BROWSER_LOW_MEMORY

afterEach(() => {
	if (originalIdleTimeout === undefined) delete process.env.EIGENT_OPENCODE_IDLE_TIMEOUT_MS
	else process.env.EIGENT_OPENCODE_IDLE_TIMEOUT_MS = originalIdleTimeout
	if (originalLowMemory === undefined) delete process.env.EIGENT_BROWSER_LOW_MEMORY
	else process.env.EIGENT_BROWSER_LOW_MEMORY = originalLowMemory
})

describe("OpenCode idle lifecycle", () => {
	test("defaults to one minute on low-memory hosts and stays disabled otherwise", () => {
		delete process.env.EIGENT_OPENCODE_IDLE_TIMEOUT_MS
		process.env.EIGENT_BROWSER_LOW_MEMORY = "true"
		expect(resolveOpenCodeIdleTimeoutMs()).toBe(60_000)
		process.env.EIGENT_BROWSER_LOW_MEMORY = "false"
		expect(resolveOpenCodeIdleTimeoutMs()).toBe(0)
	})

	test("accepts an explicit timeout and clamps tiny values", () => {
		process.env.EIGENT_OPENCODE_IDLE_TIMEOUT_MS = "250"
		expect(resolveOpenCodeIdleTimeoutMs()).toBe(1_000)
		process.env.EIGENT_OPENCODE_IDLE_TIMEOUT_MS = "90000"
		expect(resolveOpenCodeIdleTimeoutMs()).toBe(90_000)
		process.env.EIGENT_OPENCODE_IDLE_TIMEOUT_MS = "0"
		expect(resolveOpenCodeIdleTimeoutMs()).toBe(0)
	})

	test("only treats an all-idle status map as safe to stop", () => {
		expect(hasActiveOpenCodeSessions({})).toBe(false)
		expect(hasActiveOpenCodeSessions({ a: { type: "idle" }, b: { type: "idle" } })).toBe(false)
		expect(hasActiveOpenCodeSessions({ a: { type: "busy" } })).toBe(true)
		expect(hasActiveOpenCodeSessions({ a: { type: "retry" } })).toBe(true)
		expect(hasActiveOpenCodeSessions({ a: {} })).toBe(true)
		expect(hasActiveOpenCodeSessions(null)).toBe(true)
		expect(hasActiveOpenCodeSessions([])).toBe(true)
	})
})
