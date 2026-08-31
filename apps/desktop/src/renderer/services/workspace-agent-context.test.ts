import { describe, expect, test } from "bun:test"
import { buildWorkspaceAgentSystemPrompt, looksLikeWebTask } from "./workspace-agent-context"

describe("workspace agent context", () => {
	test("detects Korean and English web work", () => {
		expect(looksLikeWebTask("계산기 HTML 페이지 작성")).toBe(true)
		expect(looksLikeWebTask("fix the Vite frontend")).toBe(true)
		expect(looksLikeWebTask("rename a backend variable")).toBe(false)
	})

	test("pins No Project work and documents both preview paths", () => {
		const prompt = buildWorkspaceAgentSystemPrompt({
			workspaceRoot: "/var/lib/eigent/workspaces/_no-project",
			isNoProject: true,
			userText: "계산기 HTML 페이지 작성",
		})
		expect(prompt).toContain("/var/lib/eigent/workspaces/_no-project")
		expect(prompt).toContain("persistent No Project workspace")
		expect(prompt).toContain("clicking any .html/.htm file")
		expect(prompt).toContain("127.0.0.1")
		expect(prompt).toContain("request appears web-related")
	})
})
