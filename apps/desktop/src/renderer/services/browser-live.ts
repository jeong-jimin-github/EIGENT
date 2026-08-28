/** Browser Live View client for the shared persistent EIGENT browser. */

export interface BrowserTabInfo {
	id: string
	url: string
	title: string
	loading?: boolean
}

export interface BrowserDialogInfo {
	type: string
	message: string
	defaultValue?: string
}

export interface BrowserActivityInfo {
	sequence: number
	kind: string
	phase: string
	pageId: string | null
	at: number
	action?: string
	url?: string
	filename?: string
	error?: string
}

export interface BrowserTransferInfo {
	kind: "upload" | "download"
	state: string
	pageId?: string
	at: number
	filename?: string
	path?: string
	files?: string[]
}

export interface BrowserLiveSnapshot {
	capturedAt: number
	pageId: string
	url: string
	title: string
	loading: boolean
	viewport: { width: number; height: number; deviceScaleFactor: number } | null
	mimeType: "image/jpeg"
	imageBase64?: string
	tabs: BrowserTabInfo[]
	activity?: BrowserActivityInfo | null
	dialog?: BrowserDialogInfo | null
	transfer?: BrowserTransferInfo | null
}

export type BrowserLiveServerMessage =
	| { type: "snapshot"; snapshot: BrowserLiveSnapshot }
	| { type: "error"; error: string }

export function browserLiveWebSocketUrl(options: {
	fps?: number
	quality?: number
	pageId?: string
} = {}): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
	const query = new URLSearchParams()
	if (options.fps !== undefined) query.set("fps", String(options.fps))
	if (options.quality !== undefined) query.set("quality", String(options.quality))
	if (options.pageId) query.set("pageId", options.pageId)
	const suffix = query.size > 0 ? `?${query}` : ""
	return `${protocol}//${window.location.host}/api/browser/live/ws${suffix}`
}

async function browserAction<T>(body: Record<string, unknown>): Promise<T> {
	const response = await fetch("/api/browser/action", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	})
	const data = (await response.json()) as { result?: T; error?: string }
	if (!response.ok) throw new Error(data.error ?? `${response.status} ${response.statusText}`)
	return data.result as T
}

export async function reloadBrowserPage(pageId: string): Promise<void> {
	await browserAction({ action: "reload", pageId })
}

export async function handleBrowserDialog(
	pageId: string,
	accept: boolean,
	promptText?: string,
): Promise<void> {
	await browserAction({ action: "dialog", pageId, accept, promptText })
}
