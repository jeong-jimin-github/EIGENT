import net from "node:net"
import path from "node:path"
import { Hono } from "hono"
import { createBunWebSocket } from "hono/bun"
import { cors } from "hono/cors"
import agents from "./routes/agents"
import browser from "./routes/browser"
import desktop from "./routes/desktop"
import git from "./routes/git"
import health from "./routes/health"
import modelState from "./routes/model-state"
import processes from "./routes/processes"
import recovery from "./routes/recovery"
import servers from "./routes/servers"
import tasks from "./routes/tasks"
import workspace from "./routes/workspace"
import { browserRuntime } from "./services/browser-runtime"
import { desktopRuntime } from "./services/desktop-runtime"
import { ensureSingleServer } from "./services/server-manager"
import { createTerminalSession, type TerminalSession } from "./services/terminal-session"

const app = new Hono()
const { upgradeWebSocket, websocket } = createBunWebSocket()

app.get(
	"/api/terminal/ws",
	upgradeWebSocket((c) => {
		const cwd = c.req.query("cwd") || process.env.HOME || process.cwd()
		let terminal: TerminalSession | null = null

		return {
			onOpen(_event, ws) {
				try {
					terminal = createTerminalSession({
						cwd,
						onData: (data) => ws.send(data),
						onExit: (exitCode) => {
							ws.send(`

[EIGENT terminal exited: ${exitCode}]

`)
							ws.close()
						},
					})
				} catch (err) {
					ws.send(`

[EIGENT terminal error: ${err instanceof Error ? err.message : String(err)}]

`)
					ws.close()
				}
			},
			onMessage(event) {
				if (!terminal) return
				const raw = typeof event.data === "string" ? event.data : event.data.toString()
				try {
					const message = JSON.parse(raw) as
						| { type: "input"; data: string }
						| { type: "resize"; cols: number; rows: number }
					if (message.type === "input") terminal.write(message.data)
					if (message.type === "resize") terminal.resize(message.cols, message.rows)
				} catch {
					terminal.write(raw)
				}
			},
			onClose() {
				terminal?.kill()
				terminal = null
			},
		}
	}),
)

function clampLiveNumber(value: number, fallback: number, min: number, max: number): number {
	return Number.isFinite(value) ? Math.max(min, Math.min(value, max)) : fallback
}

app.get(
	"/api/browser/live/ws",
	upgradeWebSocket((c) => {
		let selectedPageId = c.req.query("pageId") || undefined
		let fps = clampLiveNumber(
			Number(c.req.query("fps") ?? process.env.EIGENT_BROWSER_LIVE_FPS ?? 2),
			2,
			0.5,
			4,
		)
		let quality = clampLiveNumber(
			Number(c.req.query("quality") ?? process.env.EIGENT_BROWSER_LIVE_QUALITY ?? 40),
			40,
			25,
			75,
		)
		let socket: { send(data: string): void } | null = null
		let timer: ReturnType<typeof setTimeout> | null = null
		let stopped = false
		let lastImage: string | undefined
		let lastFullImageAt = 0

		function schedule() {
			if (stopped || timer) return
			timer = setTimeout(
				() => {
					timer = null
					void push()
				},
				Math.round(1000 / fps),
			)
		}

		async function push() {
			if (stopped || !socket) return
			try {
				const snapshot = await browserRuntime.liveSnapshot({ pageId: selectedPageId, quality })
				const now = Date.now()
				const nextImage = snapshot.imageBase64
				const sendImage = Boolean(
					nextImage && (nextImage !== lastImage || now - lastFullImageAt >= 5_000),
				)
				if (sendImage) {
					lastImage = nextImage
					lastFullImageAt = now
				}
				if (stopped || !socket) return
				socket.send(
					JSON.stringify({
						type: "snapshot",
						snapshot: sendImage ? snapshot : { ...snapshot, imageBase64: undefined },
					}),
				)
			} catch (error) {
				if (stopped || !socket) return
				socket.send(
					JSON.stringify({
						type: "error",
						error: error instanceof Error ? error.message : String(error),
					}),
				)
			} finally {
				schedule()
			}
		}

		return {
			onOpen(_event, ws) {
				socket = ws
				void push()
			},
			onMessage(event) {
				try {
					const raw = typeof event.data === "string" ? event.data : event.data.toString()
					const message = JSON.parse(raw) as {
						type?: string
						pageId?: string
						fps?: number
						quality?: number
					}
					if (message.type === "select") selectedPageId = message.pageId || undefined
					if (message.type === "follow") selectedPageId = undefined
					if (message.type === "refresh") lastImage = undefined
					if (message.type === "settings") {
						fps = clampLiveNumber(Number(message.fps), fps, 0.5, 4)
						quality = clampLiveNumber(Number(message.quality), quality, 25, 75)
					}
				} catch {
					/* Ignore malformed viewer control messages. */
				}
			},
			onClose() {
				stopped = true
				if (timer) clearTimeout(timer)
				timer = null
				socket = null
			},
		}
	}),
)

app.get(
	"/api/desktop/vnc/ws",
	upgradeWebSocket(() => {
		let vnc: net.Socket | null = null
		let stopped = false
		const pending: Uint8Array[] = []

		const toBytes = (data: string | ArrayBuffer | Uint8Array): Uint8Array => {
			if (typeof data === "string") return Buffer.from(data)
			if (data instanceof ArrayBuffer) return new Uint8Array(data)
			return data
		}

		return {
			onOpen(_event, ws) {
				void desktopRuntime
					.ensureReady()
					.then(() => {
						if (stopped) return
						const config = desktopRuntime.getConfig()
						vnc = net.createConnection({ host: config.vncHost, port: config.vncPort })
						vnc.on("connect", () => {
							for (const payload of pending.splice(0)) vnc?.write(payload)
						})
						vnc.on("data", (data) => {
							if (!stopped) ws.send(data)
						})
						vnc.on("error", () => ws.close())
						vnc.on("close", () => ws.close())
					})
					.catch(() => ws.close())
			},
			onMessage(event) {
				const payload = toBytes(event.data as string | ArrayBuffer | Uint8Array)
				if (vnc?.readyState === "open") vnc.write(payload)
				else pending.push(payload)
			},
			onClose() {
				stopped = true
				pending.length = 0
				vnc?.destroy()
				vnc = null
			},
		}
	}),
)

app.use(
	"/api/*",
	cors({
		origin: (origin) => {
			const configured = process.env.EIGENT_ALLOWED_ORIGINS
			if (configured) {
				const allowed = configured.split(",").map((value) => value.trim())
				return allowed.includes(origin) ? origin : ""
			}
			return origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")
				? origin
				: ""
		},
	}),
)

const routes = app
	.route("/api/agents", agents)
	.route("/api/browser", browser)
	.route("/api/desktop", desktop)
	.route("/api/git", git)
	.route("/api/processes", processes)
	.route("/api/recovery", recovery)
	.route("/api/workspace", workspace)
	.route("/api/servers", servers)
	.route("/api/tasks", tasks)
	.route("/api/model-state", modelState)
	.route("/health", health)

export type AppType = typeof routes

app.all("/api/*", (c) => c.json({ error: "Not found" }, 404))

const webRoot =
	process.env.EIGENT_WEB_ROOT ?? path.resolve(import.meta.dir, "../../desktop/dist-web")

app.get("*", async (c) => {
	const requestPath = decodeURIComponent(new URL(c.req.url).pathname)
	const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "")
	const candidate = path.resolve(webRoot, relativePath)
	const rootPrefix = `${path.resolve(webRoot)}${path.sep}`

	if (candidate.startsWith(rootPrefix)) {
		const file = Bun.file(candidate)
		if (await file.exists()) return new Response(file)
	}

	const index = Bun.file(path.join(webRoot, "index.html"))
	if (await index.exists()) return new Response(index)

	return c.json(
		{
			error: "Web client is not built",
			hint: "Run `bun run build:web` before starting the production server.",
		},
		503,
	)
})

const port = Number(process.env.PORT) || 3100
const hostname = process.env.HOST || "0.0.0.0"

console.log(`EIGENT server starting on http://${hostname}:${port}`)

void (async () => {
	if (desktopRuntime.getConfig().enabled) {
		try {
			await desktopRuntime.ensureReady()
			const desktop = await desktopRuntime.status()
			console.log(
				`Shared desktop ready at ${desktop.display} (VNC ${desktop.vncHost}:${desktop.vncPort})`,
			)
		} catch (err) {
			console.warn("Shared desktop unavailable on boot:", err instanceof Error ? err.message : err)
		}
	}

	try {
		await browserRuntime.ensureReady()
		const status = await browserRuntime.status()
		console.log(`Persistent browser ready at ${status.cdpUrl} (${status.profileDir})`)
	} catch (err) {
		console.warn(
			"Persistent browser unavailable on boot:",
			err instanceof Error ? err.message : err,
		)
	}
})()

ensureSingleServer()
	.then((server) => {
		console.log(`OpenCode server ready at ${server.url}`)
	})
	.catch((err) => {
		console.error("Failed to start OpenCode server on boot:", err)
	})

export default {
	hostname,
	port,
	fetch: app.fetch,
	websocket,
}
