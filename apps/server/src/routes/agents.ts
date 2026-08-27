import type { AgentProviderKind } from "@eigent/agent-core"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { cancelProviderAuth, getProviderAuth, startProviderAuth } from "../services/provider-auth"
import { providerRegistry } from "../services/provider-registry"

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
	.post("/sessions", async (c) => {
		const body = (await c.req.json()) as {
			provider?: AgentProviderKind
			workspace?: string
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
	.post("/sessions/:id/messages", async (c) => {
		const body = (await c.req.json()) as { message?: string }
		if (!body.message?.trim()) return c.json({ error: "message is required" }, 400)
		const id = c.req.param("id")
		if (!providerRegistry.getSession(id)) return c.json({ error: "session not found" }, 404)

		return streamSSE(c, async (stream) => {
			try {
				for await (const event of providerRegistry.events(id, body.message!)) {
					await stream.writeSSE({ event: "agent", data: JSON.stringify(event) })
				}
				await stream.writeSSE({ event: "done", data: "{}" })
			} catch (err) {
				await stream.writeSSE({
					event: "agent",
					data: JSON.stringify({ type: "error", message: errorMessage(err), recoverable: true }),
				})
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
