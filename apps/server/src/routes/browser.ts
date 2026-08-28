import { Hono } from "hono"
import { browserRuntime } from "../services/browser-runtime"
import { type BrowserAction, executeBrowserAction } from "../services/browser-tools"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const app = new Hono()
	.get("/status", async (c) => c.json(await browserRuntime.status()))
	.get("/health", async (c) => {
		const browser = await browserRuntime.status()
		return c.json({ ok: browser.connected, browser }, browser.connected ? 200 : 503)
	})
	.post("/ensure", async (c) => {
		try {
			await browserRuntime.ensureReady()
			return c.json(await browserRuntime.status())
		} catch (error) {
			return c.json({ error: message(error), ...(await browserRuntime.status()) }, 503)
		}
	})
	.post("/action", async (c) => {
		try {
			const body = (await c.req.json()) as BrowserAction
			if (!body || typeof body !== "object" || !("action" in body))
				return c.json({ error: "action is required" }, 400)
			return c.json({ result: await executeBrowserAction(body) })
		} catch (error) {
			return c.json({ error: message(error) }, 400)
		}
	})

export default app
