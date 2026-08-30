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
import push from "./routes/push"
import recovery from "./routes/recovery"
import servers from "./routes/servers"
import tasks from "./routes/tasks"
import workspace from "./routes/workspace"
import { ensureAgentCliInstalled, ensureAgentClisInstalled } from "./services/agent-cli-installer"
import { browserRuntime } from "./services/browser-runtime"
import { desktopRuntime } from "./services/desktop-runtime"
import { providerRegistry } from "./services/provider-registry"
import {
	consumeMutationRateLimit,
	isAllowedHost,
	isAllowedOrigin,
	maxRequestBytes,
} from "./services/security-policy"
import { ensureSingleServer } from "./services/server-manager"
import { createTerminalSession, type TerminalSession } from "./services/terminal-session"
import { assertWorkspaceAllowed } from "./services/workspace-policy"

const app = new Hono()
const { upgradeWebSocket, websocket } = createBunWebSocket()

app.use("/api/*", async (c, next) => {
	const host = c.req.header("host")
	if (!isAllowedHost(host)) return c.json({ error: "Host is not allowed" }, 403)
	if (!isAllowedOrigin(c.req.header("origin"), host)) {
		return c.json({ error: "Origin is not allowed" }, 403)
	}

	const declaredBytes = Number(c.req.header("content-length") ?? "0")
	if (Number.isFinite(declaredBytes) && declaredBytes > maxRequestBytes()) {
		return c.json({ error: `request exceeds ${maxRequestBytes()} byte limit` }, 413)
	}

	if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
		const rate = consumeMutationRateLimit()
		if (!rate.allowed) {
			c.header("Retry-After", String(rate.retryAfter))
			return c.json({ error: "Mutation rate limit exceeded" }, 429)
		}
	}

	await next()
})

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

app.get(
	"/api/terminal/ws",
	upgradeWebSocket((c) => {
		const requestedCwd = c.req.query("cwd") || process.env.HOME || process.cwd()
		let terminal: TerminalSession | null = null

		return {
			onOpen(_event, ws) {
				try {
					const cwd = assertWorkspaceAllowed(requestedCwd, "terminal cwd")
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

const OPENCODE_PROXY_PREFIX = "/api/opencode"
const HOP_BY_HOP_HEADERS = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
] as const

/**
 * Bun may auto-compress a Response returned by the proxy. Because the upstream
 * fetch is requested without Accept-Encoding, its body is plain bytes. Mark the
 * returned response as identity-encoded and let Bun recalculate Content-Length;
 * otherwise Bun can emit `Content-Encoding: gzip` for an uncompressed body, which
 * Chromium rejects with ERR_CONTENT_DECODING_FAILED.
 */
function sanitizeOpenCodeResponseHeaders(source: Headers, status: number): Headers {
	const headers = new Headers(source)
	for (const header of HOP_BY_HOP_HEADERS) headers.delete(header)
	headers.delete("content-length")
	headers.delete("content-encoding")
	if (status !== 204 && status !== 304) headers.set("content-encoding", "identity")
	return headers
}

type OpenCodeProxyCacheEntry = {
	status: number
	statusText: string
	headers: [string, string][]
	body: Uint8Array
	storedAt: number
}

const OPENCODE_CACHEABLE_PATHS = new Set(["/provider", "/provider/", "/config/providers"])
const OPENCODE_PROXY_CACHE_FRESH_MS = 30_000
const OPENCODE_PROXY_CACHE_STALE_MS = 10 * 60_000
const openCodeProxyCache = new Map<string, OpenCodeProxyCacheEntry>()
const openCodeProxyRefreshes = new Map<string, Promise<void>>()

function openCodeProxyCacheKey(targetUrl: URL, headers: Headers): string {
	const directory = headers.get("x-opencode-directory") ?? ""
	return `${targetUrl.pathname}${targetUrl.search}::${directory}`
}

function responseFromOpenCodeCache(entry: OpenCodeProxyCacheEntry, cacheState: "HIT" | "STALE"): Response {
	const headers = sanitizeOpenCodeResponseHeaders(new Headers(entry.headers), entry.status)
	headers.set("X-EIGENT-OpenCode-Cache", cacheState)
	return new Response(entry.body.slice(), {
		status: entry.status,
		statusText: entry.statusText,
		headers,
	})
}

async function fetchOpenCodeCached(targetUrl: URL, headers: Headers): Promise<OpenCodeProxyCacheEntry> {
	const upstream = await fetch(targetUrl, { method: "GET", headers, redirect: "manual" })
	const responseHeaders = sanitizeOpenCodeResponseHeaders(upstream.headers, upstream.status)
	const body = new Uint8Array(await upstream.arrayBuffer())
	const entry: OpenCodeProxyCacheEntry = {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: [...responseHeaders.entries()],
		body,
		storedAt: Date.now(),
	}
	if (upstream.ok) openCodeProxyCache.set(openCodeProxyCacheKey(targetUrl, headers), entry)
	return entry
}

function refreshOpenCodeCache(targetUrl: URL, headers: Headers): void {
	const key = openCodeProxyCacheKey(targetUrl, headers)
	if (openCodeProxyRefreshes.has(key)) return
	const refresh = fetchOpenCodeCached(targetUrl, headers)
		.then(() => undefined)
		.catch((err) => console.warn(`OpenCode cache refresh failed for ${targetUrl.pathname}:`, err))
		.finally(() => openCodeProxyRefreshes.delete(key))
	openCodeProxyRefreshes.set(key, refresh)
}

async function warmOpenCodeProviderCache(serverUrl: string): Promise<void> {
	const headers = new Headers({ accept: "application/json" })
	for (const pathname of ["/provider", "/config/providers"]) {
		const targetUrl = new URL(pathname, serverUrl)
		try {
			await fetchOpenCodeCached(targetUrl, headers)
			console.log(`OpenCode proxy cache warmed: ${pathname}`)
		} catch (err) {
			console.warn(`OpenCode proxy cache warm failed for ${pathname}:`, err)
		}
	}
}

// Browser deployments need a same-origin path to the loopback-only OpenCode
// server. This proxy keeps port 4101 private while supporting normal JSON API
// calls and streaming SSE responses used by the OpenCode SDK.
app.all(`${OPENCODE_PROXY_PREFIX}/*`, async (c) => {
	try {
		const server = await ensureSingleServer()
		const incomingUrl = new URL(c.req.url)
		const targetUrl = new URL(server.url)
		const suffix = incomingUrl.pathname.slice(OPENCODE_PROXY_PREFIX.length) || "/"
		targetUrl.pathname = suffix.startsWith("/") ? suffix : `/${suffix}`
		targetUrl.search = incomingUrl.search

		const headers = new Headers(c.req.raw.headers)
		for (const header of HOP_BY_HOP_HEADERS) headers.delete(header)
		// The outer reverse proxy may use HTTP Basic Auth. Never forward that
		// credential (or browser cookies/referrer) to the loopback OpenCode server.
		headers.delete("authorization")
		headers.delete("cookie")
		headers.delete("host")
		headers.delete("origin")
		headers.delete("referer")
		headers.delete("accept-encoding")

		const method = c.req.method.toUpperCase()
		const cacheable = method === "GET" && OPENCODE_CACHEABLE_PATHS.has(targetUrl.pathname)
		if (cacheable) {
			const key = openCodeProxyCacheKey(targetUrl, headers)
			const cached = openCodeProxyCache.get(key)
			if (cached) {
				const age = Date.now() - cached.storedAt
				if (age <= OPENCODE_PROXY_CACHE_STALE_MS) {
					if (age > OPENCODE_PROXY_CACHE_FRESH_MS) refreshOpenCodeCache(targetUrl, headers)
					return responseFromOpenCodeCache(cached, age > OPENCODE_PROXY_CACHE_FRESH_MS ? "STALE" : "HIT")
				}
				openCodeProxyCache.delete(key)
			}
			const entry = await fetchOpenCodeCached(targetUrl, headers)
			return responseFromOpenCodeCache(entry, "HIT")
		}

		const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer()
		const upstream = await fetch(targetUrl, {
			method,
			headers,
			body,
			redirect: "manual",
		})

		if (!["GET", "HEAD", "OPTIONS"].includes(method) && upstream.ok) {
			openCodeProxyCache.clear()
		}

		const responseHeaders = sanitizeOpenCodeResponseHeaders(upstream.headers, upstream.status)
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: responseHeaders,
		})
	} catch (err) {
		const message = err instanceof Error ? err.message : "OpenCode proxy failed"
		return c.json({ error: message }, 502)
	}
})

const routes = app
	.route("/api/agents", agents)
	.route("/api/browser", browser)
	.route("/api/desktop", desktop)
	.route("/api/git", git)
	.route("/api/processes", processes)
	.route("/api/push", push)
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
const configuredIdleTimeout = Number(process.env.EIGENT_HTTP_IDLE_TIMEOUT_SECONDS ?? "120")
const idleTimeout = Number.isFinite(configuredIdleTimeout)
	? Math.min(255, Math.max(0, Math.trunc(configuredIdleTimeout)))
	: 120

console.log(`EIGENT server starting on http://${hostname}:${port}`)

void ensureAgentClisInstalled()
	.then(() => providerRegistry.refreshSnapshots())
	.then(() => console.log("Agent provider snapshot cache warmed"))
	.catch((err) => {
		console.warn("Automatic agent CLI/provider warmup failed:", err instanceof Error ? err.message : err)
	})

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

ensureAgentCliInstalled("opencode")
	.then(() => ensureSingleServer())
	.then((server) => {
		console.log(`OpenCode server ready at ${server.url}`)
		void warmOpenCodeProviderCache(server.url)
	})
	.catch((err) => {
		console.error("Failed to install/start OpenCode server on boot:", err)
	})

export default {
	hostname,
	port,
	idleTimeout,
	maxRequestBodySize: maxRequestBytes(),
	fetch: app.fetch,
	websocket,
}
