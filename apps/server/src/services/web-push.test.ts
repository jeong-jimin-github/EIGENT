import { describe, expect, test } from "bun:test"
import type { AgentSession } from "@eigent/agent-core"
import { notificationForAgentEvent, WebPushService } from "./web-push"

const session: AgentSession = {
	id: "agent-session-1",
	provider: "codex",
	model: "gpt-test",
	workspace: "/tmp/eigent/project-alpha",
	state: "running",
	createdAt: 1,
}

describe("WebPushService", () => {
	test("maps attention and terminal agent events to deduplicated notifications", () => {
		const completed = notificationForAgentEvent(
			session,
			{ type: "run.completed", requestId: "request-1" },
			"ui-session-1",
		)
		expect(completed).toMatchObject({
			category: "completion",
			tag: "eigent:agent-session-1:run:request-1",
			sessionId: "agent-session-1",
			uiSessionId: "ui-session-1",
		})
		expect(completed?.url).toContain("uiSession=ui-session-1")

		expect(
			notificationForAgentEvent(session, { type: "question", id: "q1", prompt: "Choose" })
				?.category,
		).toBe("question")
		expect(
			notificationForAgentEvent(session, {
				type: "permission",
				id: "p1",
				prompt: "Allow command?",
			})?.category,
		).toBe("permission")
		expect(notificationForAgentEvent(session, { type: "message.delta", text: "quiet" })).toBeNull()
	})

	test("deduplicates browser subscriptions by endpoint and updates categories", () => {
		const service = new WebPushService(":memory:")
		service.upsert({
			endpoint: "https://push.example/subscription",
			keys: { p256dh: "key", auth: "auth" },
		})
		service.upsert({
			endpoint: "https://push.example/subscription",
			keys: { p256dh: "key-2", auth: "auth-2" },
			categories: { completion: false },
		})
		expect(service.list()).toHaveLength(1)
		expect(service.list()[0]?.categories.completion).toBe(false)
		expect(service.list()[0]?.categories.failure).toBe(true)
	})

	test("keeps the visible chat deep-link mapping", () => {
		const service = new WebPushService(":memory:")
		service.bindSession("agent-session-1", "ui-session-9")
		expect(service.getUiSessionId("agent-session-1")).toBe("ui-session-9")
	})
})
