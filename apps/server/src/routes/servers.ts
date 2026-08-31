import { Hono } from "hono"
import { createServerBackup, restoreServerBackup } from "../services/server-backup"
import { ensureSingleServer, getServerUrl, stopServer } from "../services/server-manager"

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const app = new Hono()
	.get("/backup/export", async (c) => {
		try {
			const backup = await createServerBackup()
			const stamp = new Date().toISOString().slice(0, 10)
			c.header("Content-Type", "application/json; charset=utf-8")
			c.header("Content-Disposition", `attachment; filename="eigent-server-backup-${stamp}.json"`)
			c.header("Cache-Control", "no-store")
			return c.body(JSON.stringify(backup, null, 2))
		} catch (error) {
			return c.json({ error: errorMessage(error) }, 500)
		}
	})
	.post("/backup/import", async (c) => {
		try {
			const result = await restoreServerBackup(await c.req.text())
			stopServer()
			return c.json(result, result.success ? 200 : 207)
		} catch (error) {
			return c.json({ success: false, error: errorMessage(error) }, 400)
		}
	})
	// New primary endpoint — ensures the single server is running and returns its URL
	.get("/opencode", async (c) => {
		try {
			await ensureSingleServer()

			// Browser clients cannot use the server's loopback OpenCode URL
			// (127.0.0.1 would point at the user's own machine). Route them
			// through EIGENT's same-origin HTTP proxy instead.
			const requestUrl = new URL(c.req.url)
			const forwardedProto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim()
			const forwardedHost = c.req.header("x-forwarded-host")?.split(",")[0]?.trim()
			const protocol = forwardedProto || requestUrl.protocol.replace(/:$/, "")
			const host = forwardedHost || c.req.header("host") || requestUrl.host
			return c.json({ url: `${protocol}://${host}/api/opencode` }, 200)
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to start OpenCode server"
			return c.json({ error: message }, 500)
		}
	})
	// Keep legacy endpoints for backward compat during transition
	.get("/", async (c) => {
		const url = getServerUrl()
		const servers = url
			? [{ id: "single", url, directory: "", name: "opencode", pid: null, managed: true }]
			: []
		return c.json({ servers }, 200)
	})
	.post("/start", async (c) => {
		try {
			const server = await ensureSingleServer()
			return c.json(
				{
					server: {
						id: "single",
						url: server.url,
						directory: "",
						name: "opencode",
						pid: server.pid,
						managed: server.managed,
					},
				},
				200,
			)
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to start server"
			return c.json({ error: message }, 500)
		}
	})
	.post("/stop", async (c) => {
		const stopped = stopServer()
		return c.json({ stopped }, 200)
	})

export default app
