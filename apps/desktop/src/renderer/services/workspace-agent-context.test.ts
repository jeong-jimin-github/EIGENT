import { describe, expect, test } from "bun:test"
import { buildWorkspaceAgentSystemPrompt, looksLikeWebTask } from "./workspace-agent-context"

describe("workspace agent context", () => {
	test("detects Korean and English web work", () => {
		expect(looksLikeWebTask("계산기 HTML 페이지 작성")).toBe(true)
		expect(looksLikeWebTask("fix the Vite frontend")).toBe(true)
		expect(looksLikeWebTask("rename a backend variable")).toBe(false)
	})

	test("pins No Project work and documents session-scoped explicit previews", () => {
		const prompt = buildWorkspaceAgentSystemPrompt({
			workspaceRoot: "/var/lib/eigent/workspaces/_no-project",
			isNoProject: true,
			userText: "계산기 HTML 페이지 작성",
			sessionId: "ui-session-123",
		})
		expect(prompt).toContain("/var/lib/eigent/workspaces/_no-project")
		expect(prompt).toContain("persistent No Project workspace")
		expect(prompt).toContain("ui-session-123")
		expect(prompt).toContain("does NOT auto-detect index.html")
		expect(prompt).toContain("/api/workspace/session-preview")
		expect(prompt).toContain('"kind":"workspace"')
		expect(prompt).toContain('"path":"<workspace-relative-html-path>"')
		expect(prompt).toContain('"kind":"loopback"')
		expect(prompt).toContain("/api/workspace/session-preview/reload")
		expect(prompt).toContain("-X DELETE")
		expect(prompt).toContain("persists across EIGENT page refreshes")
		expect(prompt).toContain("Do not clear it automatically")
		expect(prompt).toContain("Do not ask the user to press refresh")
		expect(prompt).toContain("request appears web-related")
	})
})
