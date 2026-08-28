import { Hono } from "hono"
import { type ComputerAction, desktopRuntime } from "../services/desktop-runtime"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const app = new Hono()
	.get("/status", async (c) => c.json(await desktopRuntime.status()))
	.get("/health", async (c) => {
		const desktop = await desktopRuntime.status()
		return c.json({ ok: desktop.ready, desktop }, desktop.ready ? 200 : 503)
	})
	.post("/ensure", async (c) => {
		try {
			await desktopRuntime.ensureReady()
			return c.json(await desktopRuntime.status())
		} catch (error) {
			return c.json({ error: message(error), ...(await desktopRuntime.status()) }, 503)
		}
	})
	.post("/restart", async (c) => {
		try {
			await desktopRuntime.restart()
			return c.json(await desktopRuntime.status())
		} catch (error) {
			return c.json({ error: message(error), ...(await desktopRuntime.status()) }, 503)
		}
	})
	.post("/control/take", (c) => c.json(desktopRuntime.takeControl()))
	.post("/control/return", (c) => c.json(desktopRuntime.returnControl()))
	.post("/computer", async (c) => {
		try {
			const body = (await c.req.json()) as ComputerAction
			if (!body || typeof body !== "object" || !("action" in body)) {
				return c.json({ error: "action is required" }, 400)
			}
			return c.json({ result: await desktopRuntime.action(body) })
		} catch (error) {
			return c.json({ error: message(error) }, 400)
		}
	})
	.post("/files", async (c) => {
		try {
			const body = await c.req.parseBody()
			const upload = body.file
			if (!(upload instanceof File)) return c.json({ error: "file is required" }, 400)
			const bytes = new Uint8Array(await upload.arrayBuffer())
			const storedPath = desktopRuntime.storeSharedFile(upload.name, bytes)
			return c.json({ path: storedPath, name: upload.name, size: bytes.byteLength })
		} catch (error) {
			return c.json({ error: message(error) }, 400)
		}
	})

export default app
