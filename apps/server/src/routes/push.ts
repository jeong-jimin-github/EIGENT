import { Hono } from "hono"
import { type PushCategories, webPushService } from "../services/web-push"

const app = new Hono()
	.get("/config", (c) => c.json(webPushService.getConfig(), 200))
	.post("/subscriptions", async (c) => {
		const body = (await c.req.json()) as {
			endpoint?: string
			keys?: { p256dh?: string; auth?: string }
			categories?: Partial<PushCategories>
		}
		if (!body.endpoint || !body.keys?.p256dh || !body.keys.auth)
			return c.json({ error: "endpoint and push subscription keys are required" }, 400)
		if (!webPushService.getConfig().enabled)
			return c.json({ error: "Web Push is not configured on this server" }, 503)
		const subscription = webPushService.upsert({
			endpoint: body.endpoint,
			keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
			categories: body.categories,
		})
		return c.json({ subscription }, 201)
	})
	.delete("/subscriptions", async (c) => {
		const body = (await c.req.json()) as { endpoint?: string }
		if (!body.endpoint) return c.json({ error: "endpoint is required" }, 400)
		return c.json({ removed: webPushService.remove(body.endpoint) }, 200)
	})

export default app
