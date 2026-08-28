import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
	consumeMutationRateLimit,
	isAllowedHost,
	isAllowedOrigin,
	maxRequestBytes,
	maxUploadBytes,
	resetSecurityRateLimitForTests,
} from "./security-policy"

const managedEnv = [
	"EIGENT_ALLOWED_HOSTS",
	"EIGENT_ALLOWED_ORIGINS",
	"EIGENT_MAX_REQUEST_BYTES",
	"EIGENT_MAX_UPLOAD_BYTES",
	"EIGENT_MUTATION_RATE_LIMIT_PER_MINUTE",
] as const
const original = new Map<string, string | undefined>()

beforeEach(() => {
	for (const key of managedEnv) {
		original.set(key, process.env[key])
		delete process.env[key]
	}
	resetSecurityRateLimitForTests()
})

afterEach(() => {
	for (const key of managedEnv) {
		const value = original.get(key)
		if (value === undefined) delete process.env[key]
		else process.env[key] = value
	}
	resetSecurityRateLimitForTests()
})

describe("security policy", () => {
	test("keeps local development permissive while rejecting unrelated origins", () => {
		expect(isAllowedHost("localhost:3100")).toBe(true)
		expect(isAllowedOrigin("http://localhost:5173", "localhost:3100")).toBe(true)
		expect(isAllowedOrigin("https://attacker.example", "localhost:3100")).toBe(false)
	})

	test("enforces configured host and origin allowlists", () => {
		process.env.EIGENT_ALLOWED_HOSTS = "eigent.example.com,127.0.0.1:3100"
		process.env.EIGENT_ALLOWED_ORIGINS = "https://eigent.example.com"
		expect(isAllowedHost("eigent.example.com")).toBe(true)
		expect(isAllowedHost("evil.example.com")).toBe(false)
		expect(isAllowedOrigin("https://eigent.example.com", "eigent.example.com")).toBe(true)
		expect(isAllowedOrigin("https://evil.example.com", "eigent.example.com")).toBe(false)
	})

	test("parses request/upload limits and applies optional mutation throttling", () => {
		process.env.EIGENT_MAX_REQUEST_BYTES = "4096"
		process.env.EIGENT_MAX_UPLOAD_BYTES = "2048"
		process.env.EIGENT_MUTATION_RATE_LIMIT_PER_MINUTE = "2"
		expect(maxRequestBytes()).toBe(4096)
		expect(maxUploadBytes()).toBe(2048)
		expect(consumeMutationRateLimit(1_000).allowed).toBe(true)
		expect(consumeMutationRateLimit(1_001).allowed).toBe(true)
		expect(consumeMutationRateLimit(1_002).allowed).toBe(false)
	})
})
