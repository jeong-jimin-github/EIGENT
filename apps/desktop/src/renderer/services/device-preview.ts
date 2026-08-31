import type { FileDiff } from "../lib/types"

export interface WorkspacePreviewSession {
	token: string
	expiresAt: number
	entryPath: string | null
}

export interface LoopbackPreviewSession {
	token: string
	expiresAt: number
	path: string
}

export async function createWorkspacePreviewSession(
	root: string,
	changedFiles: string[],
): Promise<WorkspacePreviewSession> {
	const response = await fetch("/api/workspace/preview-token", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ root, changedFiles }),
	})
	const data = (await response.json()) as WorkspacePreviewSession & { error?: string }
	if (!response.ok) throw new Error(data.error ?? `${response.status} ${response.statusText}`)
	return data
}

export function devicePreviewUrl(token: string, entryPath: string, revision: string): string {
	const encodedPath = entryPath
		.replaceAll("\\", "/")
		.split("/")
		.filter(Boolean)
		.map(encodeURIComponent)
		.join("/")
	return `/preview/${token}/${encodedPath || "index.html"}?v=${encodeURIComponent(revision)}`
}

export function isLoopbackPreviewUrl(value: string): boolean {
	try {
		const url = new URL(value)
		const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
		return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(hostname)
	} catch {
		return false
	}
}

export async function createLoopbackPreviewSession(url: string): Promise<LoopbackPreviewSession> {
	const response = await fetch("/api/browser/device-preview-token", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ url }),
	})
	const data = (await response.json()) as LoopbackPreviewSession & { error?: string }
	if (!response.ok) throw new Error(data.error ?? `${response.status} ${response.statusText}`)
	return data
}

export function loopbackPreviewUrl(token: string, initialPath: string, revision: string): string {
	const parsed = new URL(initialPath || "/", "http://preview.invalid")
	const encodedPath = parsed.pathname
		.split("/")
		.filter(Boolean)
		.map(encodeURIComponent)
		.join("/")
	parsed.searchParams.set("eigent_preview_revision", revision)
	return `/local-preview/${token}/${encodedPath}${parsed.search}`
}

const WEB_PREVIEW_SIGNAL_EXTENSIONS = /\.(?:html?|css|s[ac]ss|less|jsx|tsx|vue|svelte)$/i
const WEB_ASSET_EXTENSIONS = /\.(?:html?|css|s[ac]ss|less|m?js|jsx|cjs|ts|tsx|vue|svelte)$/i

export function hasWebPreviewChanges(diffs: FileDiff[]): boolean {
	return diffs.some((diff) => WEB_PREVIEW_SIGNAL_EXTENSIONS.test(diff.file))
}

export function webPreviewChangedFiles(diffs: FileDiff[]): string[] {
	return diffs.filter((diff) => WEB_ASSET_EXTENSIONS.test(diff.file)).map((diff) => diff.file)
}

export function webPreviewRevision(diffs: FileDiff[]): string {
	let hash = 2166136261
	for (const diff of diffs) {
		if (!WEB_ASSET_EXTENSIONS.test(diff.file)) continue
		const value = `${diff.file}\u0000${diff.after ?? ""}\u0000${diff.additions}:${diff.deletions}`
		for (let index = 0; index < value.length; index += 1) {
			hash ^= value.charCodeAt(index)
			hash = Math.imul(hash, 16777619)
		}
	}
	return (hash >>> 0).toString(36)
}
