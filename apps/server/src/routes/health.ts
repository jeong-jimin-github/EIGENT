import { Hono } from "hono"
import { browserRuntime } from "../services/browser-runtime"
import { desktopRuntime } from "../services/desktop-runtime"
import { listManagedProcesses } from "../services/process-manager"
import { providerRegistry } from "../services/provider-registry"

function now() {
	return { status: "ok" as const, timestamp: Date.now() }
}

const app = new Hono()
	.get("/", (c) => c.json(now(), 200))
	.get("/live", (c) => c.json(now(), 200))
	.get("/agents", async (c) => {
		try {
			const providers = await providerRegistry.snapshots()
			return c.json({ ...now(), providers: providers.length }, 200)
		} catch (error) {
			return c.json(
				{
					status: "degraded" as const,
					timestamp: Date.now(),
					error: error instanceof Error ? error.message : String(error),
				},
				503,
			)
		}
	})
	.get("/browser", async (c) => {
		const browser = await browserRuntime.status()
		return c.json(
			{ ...now(), connected: browser.connected, state: browser.state },
			browser.connected ? 200 : 503,
		)
	})
	.get("/processes", (c) => {
		const processes = listManagedProcesses()
		return c.json(
			{
				...now(),
				total: processes.length,
				running: processes.filter((process) => process.state === "running").length,
			},
			200,
		)
	})
	.get("/ready", async (c) => {
		const [browser, desktop, providers] = await Promise.allSettled([
			browserRuntime.status(),
			desktopRuntime.status(),
			providerRegistry.snapshots(),
		])
		const processes = listManagedProcesses()
		return c.json(
			{
				...now(),
				components: {
					browser:
						browser.status === "fulfilled"
							? { ok: browser.value.connected, state: browser.value.state }
							: { ok: false, state: "error" },
					desktop:
						desktop.status === "fulfilled"
							? {
									ok: desktop.value.ready || !desktop.value.enabled,
									state: desktop.value.state,
								}
							: { ok: false, state: "error" },
					agents: {
						ok: providers.status === "fulfilled",
						providers: providers.status === "fulfilled" ? providers.value.length : 0,
					},
					processes: {
						ok: true,
						total: processes.length,
						running: processes.filter((process) => process.state === "running").length,
					},
				},
			},
			200,
		)
	})

export default app
