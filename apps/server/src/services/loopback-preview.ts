/** Tokenized proxy sessions for dev servers opened by EIGENT's cloud browser. */
import { randomBytes } from "node:crypto"

const PREVIEW_TTL_MS = 60 * 60 * 1000
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

interface LoopbackPreviewSession {
	origin: string
	expiresAt: number
}

const sessions = new Map<string, LoopbackPreviewSession>()

function cleanupExpired(now = Date.now()) {
	for (const [token, session] of sessions) {
		if (session.expiresAt <= now) sessions.delete(token)
	}
}

export function isLoopbackPreviewUrl(value: string): boolean {
	try {
		const url = new URL(value)
		if (url.protocol !== "http:") return false
		const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
		if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) return false
		const serverPort = String(Number(process.env.PORT) || 3100)
		if ((url.port || "80") === serverPort) return false
		return true
	} catch {
		return false
	}
}

export function createLoopbackPreviewSession(value: string) {
	cleanupExpired()
	if (!isLoopbackPreviewUrl(value))
		throw new Error("preview URL is not an allowed loopback dev server")
	const url = new URL(value)
	const token = randomBytes(24).toString("base64url")
	const expiresAt = Date.now() + PREVIEW_TTL_MS
	sessions.set(token, { origin: url.origin, expiresAt })
	return { token, expiresAt, path: `${url.pathname}${url.search}` || "/" }
}

function requireSession(token: string): LoopbackPreviewSession {
	cleanupExpired()
	const session = sessions.get(token)
	if (!session) throw new Error("loopback preview session is invalid or expired")
	session.expiresAt = Date.now() + PREVIEW_TTL_MS
	return session
}

function previewPrefix(token: string) {
	return `/local-preview/${token}/`
}

function rewriteRootReferences(text: string, token: string, contentType: string): string {
	const prefix = previewPrefix(token)
	let output = text
	if (contentType.includes("text/html")) {
		output = output
			.replace(/\b(src|href|action)(\s*=\s*["'])\/(?!\/)/gi, (_match, attribute, separator) => {
				return `${attribute}${separator}${prefix}`
			})
			.replace(/url\((\s*["']?)\/(?!\/)/gi, (_match, quote) => `url(${quote}${prefix}`)
	}
	if (contentType.includes("text/css")) {
		output = output.replace(/url\((\s*["']?)\/(?!\/)/gi, (_match, quote) => `url(${quote}${prefix}`)
	}
	if (
		contentType.includes("javascript") ||
		contentType.includes("ecmascript") ||
		contentType.includes("typescript")
	) {
		output = output
			.replace(/(\bfrom\s*["'])\/(?!\/)/g, `$1${prefix}`)
			.replace(/(\bimport\s*["'])\/(?!\/)/g, `$1${prefix}`)
			.replace(/(\bimport\s*\(\s*["'])\/(?!\/)/g, `$1${prefix}`)
	}
	return output
}

function proxyHeaders(source: Headers): Headers {
	const headers = new Headers(source)
	for (const name of HOP_BY_HOP_HEADERS) headers.delete(name)
	headers.delete("content-length")
	headers.delete("content-encoding")
	headers.set("Cache-Control", "no-store")
	headers.set("Referrer-Policy", "no-referrer")
	headers.set("X-Content-Type-Options", "nosniff")
	return headers
}

export async function proxyLoopbackPreviewRequest(
	token: string,
	requestPath: string,
	request: Request,
): Promise<Response> {
	const session = requireSession(token)
	const incoming = new URL(request.url)
	const relativePath = requestPath.replace(/^\/+/, "")
	const target = new URL(`/${relativePath}${incoming.search}`, session.origin)
	const headers = new Headers(request.headers)
	for (const name of HOP_BY_HOP_HEADERS) headers.delete(name)
	for (const name of ["authorization", "cookie", "host", "origin", "referer", "accept-encoding"])
		headers.delete(name)

	const method = request.method.toUpperCase()
	const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer()
	const upstream = await fetch(target, { method, headers, body, redirect: "manual" })
	const responseHeaders = proxyHeaders(upstream.headers)
	const location = responseHeaders.get("location")
	if (location) {
		try {
			const redirect = new URL(location, target)
			if (redirect.origin === session.origin) {
				responseHeaders.set(
					"location",
					`${previewPrefix(token)}${redirect.pathname.replace(/^\/+/, "")}${redirect.search}${redirect.hash}`,
				)
			}
		} catch {
			/* Preserve an unparsable upstream Location header. */
		}
	}

	if (method === "HEAD" || upstream.status === 204 || upstream.status === 304) {
		return new Response(null, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: responseHeaders,
		})
	}

	const contentType = responseHeaders.get("content-type")?.toLowerCase() ?? ""
	if (
		contentType.includes("text/html") ||
		contentType.includes("text/css") ||
		contentType.includes("javascript") ||
		contentType.includes("ecmascript") ||
		contentType.includes("typescript")
	) {
		const text = rewriteRootReferences(await upstream.text(), token, contentType)
		return new Response(text, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: responseHeaders,
		})
	}

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: responseHeaders,
	})
}
