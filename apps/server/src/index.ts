import path from "node:path"
import { Hono } from "hono"
import { createBunWebSocket } from "hono/bun"
import { cors } from "hono/cors"
import agents from "./routes/agents"
import git from "./routes/git"
import health from "./routes/health"
import modelState from "./routes/model-state"
import processes from "./routes/processes"
import recovery from "./routes/recovery"
import servers from "./routes/servers"
import tasks from "./routes/tasks"
import workspace from "./routes/workspace"
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
