import type { AgentProviderKind } from "@eigent/agent-core"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { type AgentRunStart, isRunTerminalEvent } from "../services/agent-run-coordinator"
import { agentRuns } from "../services/agent-runs"
import { cancelProviderAuth, getProviderAuth, startProviderAuth } from "../services/provider-auth"
import { providerRegistry } from "../services/provider-registry"
import { stateStore } from "../services/state"

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

const app = new Hono()
	.get("/providers", async (c) => c.json({ providers: await providerRegistry.snapshots() }, 200))
	.post("/providers/:provider/auth", (c) => {
		const provider = c.req.param("provider")
		if (provider !== "codex" && provider !== "claude") {
			return c.json({ error: "Only codex and claude use interactive CLI auth" }, 400)
		}
		try {
			return c.json(startProviderAuth(provider), 202)
		} catch (err) {
			return c.json({ error: errorMessage(err) }, 400)
		}
	})
	.get("/auth/:id", (c) => {
		const task = getProviderAuth(c.req.param("id"))
		return task ? c.json(task, 200) : c.json({ error: "auth task not found" }, 404)
	})
	.post("/auth/:id/cancel", (c) =>
		cancelProviderAuth(c.req.param("id"))
			? c.json({ cancelled: true }, 200)
			: c.json({ error: "auth task is not running" }, 409),
	)
	.get("/sessions", (c) =>
		c.json({ sessions: providerRegistry.listSessions(c.req.query("workspace")) }, 200),
	)
	.post("/sessions", async (c) => {
		const body = (await c.req.json()) as {
			provider?: AgentProviderKind
			workspace?: string
			taskId?: string
			model?: string
			yolo?: boolean
			systemPrompt?: string
		}
		if (!body.provider || !body.workspace || !body.model) {
			return c.json({ error: "provider, workspace and model are required" }, 400)
		}
		try {
			const session = await providerRegistry.start(body.provider, {
				workspace: body.workspace,
				taskId: body.taskId,
				model: body.model,
				yolo: body.yolo ?? true,
				systemPrompt: body.systemPrompt,
			})
			return c.json(session, 201)
		} catch (err) {
			return c.json({ error: errorMessage(err) }, 400)
		}
	})
	.get("/sessions/:id", (c) => {
		const session = providerRegistry.getSession(c.req.param("id"))
		return session ? c.json(session, 200) : c.json({ error: "session not found" }, 404)
	})
	.get("/sessions/:id/events", (c) => {
		const id = c.req.param("id")
		if (!providerRegistry.getSession(id)) return c.json({ error: "session not found" }, 404)
		const after = Number(c.req.query("after") ?? "0")
		if (!Number.isInteger(after) || after < 0) {
			return c.json({ error: "after must be a non-negative integer" }, 400)
		}
		return c.json({ events: providerRegistry.getEvents(id, after) }, 200)
	})
	.get("/sessions/:id/recovery", (c) => {
		const id = c.req.param("id")
		const session = providerRegistry.getSession(id)
		if (!session) return c.json({ error: "session not found" }, 404)
		return c.json(
			{
				session,
				lastSequence: stateStore.getLastAgentEventSequence(id),
				activeRequestId: agentRuns.getActiveRequestId(id),
				running: agentRuns.isRunning(id),
			},
			200,
		)
	})
	.get("/sessions/:id/stream", (c) => {
		const id = c.req.param("id")
		if (!providerRegistry.getSession(id)) return c.json({ error: "session not found" }, 404)
		const requestedAfter = Number(c.req.query("after") ?? c.req.header("last-event-id") ?? "0")
		if (!Number.isInteger(requestedAfter) || requestedAfter < 0) {
			return c.json({ error: "after must be a non-negative integer" }, 400)
		}
		return streamSSE(c, async (stream) => {
			let cursor = requestedAfter
			while (!c.req.raw.signal.aborted) {
				const events = providerRegistry.getEvents(id, cursor)
				for (const item of events) {
					cursor = item.sequence
					await stream.writeSSE({
						id: String(item.sequence),
						event: "agent",
						data: JSON.stringify(item.event),
					})
				}
				if (events.length === 0) {
					await agentRuns.waitForChange(id, c.req.raw.signal, 5_000)
					if (!c.req.raw.signal.aborted && providerRegistry.getEvents(id, cursor).length === 0) {
						await stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ cursor }) })
					}
				}
			}
		})
	})
	.post("/sessions/:id/messages", async (c) => {
		const body = (await c.req.json()) as { message?: string; requestId?: string }
		if (!body.message?.trim()) return c.json({ error: "message is required" }, 400)
		const id = c.req.param("id")
		if (!providerRegistry.getSession(id)) return c.json({ error: "session not found" }, 404)

		let run: AgentRunStart
		try {
			run = agentRuns.start(id, body.message.trim(), body.requestId)
		} catch (err) {
			return c.json({ error: errorMessage(err) }, 409)
		}

		return streamSSE(c, async (stream) => {
			let cursor = Math.max(0, run.startSequence - 1)
			while (!c.req.raw.signal.aborted) {
				const events = providerRegistry.getEvents(id, cursor)
				for (const item of events) {
					cursor = item.sequence
					await stream.writeSSE({
						id: String(item.sequence),
						event: "agent",
						data: JSON.stringify(item.event),
					})
					if (isRunTerminalEvent(item.event) && item.event.requestId === run.requestId) {
						await stream.writeSSE({
							event: "done",
							data: JSON.stringify({ requestId: run.requestId, cursor }),
						})
						return
					}
				}

				const session = providerRegistry.getSession(id)
				if (
					!agentRuns.isRunning(id) &&
					session &&
					!["starting", "running", "waiting_input"].includes(session.state)
				) {
					await stream.writeSSE({
						event: "done",
						data: JSON.stringify({
							requestId: run.requestId,
							cursor,
							state: session.state,
							recovered: true,
						}),
					})
					return
				}
				await agentRuns.waitForChange(id, c.req.raw.signal, 5_000)
			}
		})
	})
	.post("/sessions/:id/interrupt", async (c) => {
		try {
			await providerRegistry.interrupt(c.req.param("id"))
			return c.json({ interrupted: true }, 200)
		} catch (err) {
			return c.json({ error: errorMessage(err) }, 404)
		}
	})
	.post("/sessions/:id/resume", async (c) => {
		try {
			await providerRegistry.resume(c.req.param("id"))
			return c.json({ resumed: true }, 200)
		} catch (err) {
			return c.json({ error: errorMessage(err) }, 404)
		}
	})

export default app
