import { describe, expect, test } from "bun:test"
import { scopeOpenCodeSessionRequest } from "./opencode-proxy-scope"

describe("OpenCode session proxy scoping", () => {
	test("pins unscoped session requests to the safe No Project directory", () => {
		const headers = new Headers()
		scopeOpenCodeSessionRequest(headers, "/session/ses_123/message", "/safe/_no-project")
		expect(headers.get("x-opencode-directory")).toBe("/safe/_no-project")
	})

	test("preserves explicit project directories and leaves global endpoints alone", () => {
		const explicit = new Headers({ "x-opencode-directory": "/safe/app" })
		scopeOpenCodeSessionRequest(explicit, "/session", "/safe/_no-project")
		expect(explicit.get("x-opencode-directory")).toBe("/safe/app")

		const global = new Headers()
		scopeOpenCodeSessionRequest(global, "/global/event", "/safe/_no-project")
		expect(global.has("x-opencode-directory")).toBe(false)
	})
})
