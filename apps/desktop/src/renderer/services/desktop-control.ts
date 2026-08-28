/** Shared Linux desktop status/control API used by the noVNC project tool. */

export type DesktopControlOwner = "agent" | "user"

export interface DesktopRuntimeStatus {
	enabled: boolean
	managed: boolean
	display: string
	geometry: string
	vncHost: string
	vncPort: number
	sharedDir: string
	state: "idle" | "starting" | "ready" | "error" | "unsupported"
	supported: boolean
	ready: boolean
	controlOwner: DesktopControlOwner
	controlEpoch: number
	lastError?: string
	xReady: boolean
	vncReady: boolean
	missingCommands: string[]
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, init)
	const body = (await response.json()) as T & { error?: string }
	if (!response.ok || body.error) throw new Error(body.error ?? `${response.status} ${response.statusText}`)
	return body
}

export function desktopVncWebSocketUrl(): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
	return `${protocol}//${window.location.host}/api/desktop/vnc/ws`
}

export async function fetchDesktopStatus(signal?: AbortSignal): Promise<DesktopRuntimeStatus> {
	return jsonRequest("/api/desktop/status", { signal })
}

export async function ensureDesktop(): Promise<DesktopRuntimeStatus> {
	return jsonRequest("/api/desktop/ensure", { method: "POST" })
}

export async function restartDesktop(): Promise<DesktopRuntimeStatus> {
	return jsonRequest("/api/desktop/restart", { method: "POST" })
}

export async function takeDesktopControl(): Promise<{ controlOwner: DesktopControlOwner; controlEpoch: number }> {
	return jsonRequest("/api/desktop/control/take", { method: "POST" })
}

export async function returnDesktopControl(): Promise<{
	controlOwner: DesktopControlOwner
	controlEpoch: number
}> {
	return jsonRequest("/api/desktop/control/return", { method: "POST" })
}

export async function uploadDesktopFile(file: File): Promise<{ path: string; name: string; size: number }> {
	const form = new FormData()
	form.append("file", file)
	return jsonRequest("/api/desktop/files", { method: "POST", body: form })
}
