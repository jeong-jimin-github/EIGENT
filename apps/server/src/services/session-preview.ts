/** Agent-controlled, per-UI-session Device Preview state. */
import { randomUUID } from "node:crypto"
import { stat } from "node:fs/promises"
import path from "node:path"
import { isLoopbackPreviewUrl } from "./loopback-preview"
import { resolveWorkspaceScope } from "./workspace-policy"
import { resolveWorkspaceFilePath } from "./workspace-service"

interface SessionPreviewBase {
	sessionId: string
	root: string
	revision: number
	activationId: string
	updatedAt: number
}

export interface WorkspaceSessionPreview extends SessionPreviewBase {
	kind: "workspace"
	path: string
}

export interface LoopbackSessionPreview extends SessionPreviewBase {
	kind: "loopback"
	url: string
}

export type SessionPreviewState = WorkspaceSessionPreview | LoopbackSessionPreview

export type SetSessionPreviewInput =
	| { sessionId: string; root: string; kind: "workspace"; path: string }
	| { sessionId: string; root: string; kind: "loopback"; url: string }

const sessionPreviews = new Map<string, SessionPreviewState>()

function normalizedSessionId(value: string): string {
	const sessionId = value.trim()
	if (!sessionId) throw new Error("sessionId is required")
	if (sessionId.length > 512) throw new Error("sessionId is too long")
	return sessionId
}

function normalizeWorkspacePreviewPath(value: string): string {
	const previewPath = value.trim().replaceAll("\\", "/")
	if (!previewPath) throw new Error("preview path is required")
	if (previewPath.startsWith("/") || /^[A-Za-z]:\//.test(previewPath)) {
		throw new Error("preview path must be workspace-relative")
	}
	const normalized = path.posix.normalize(previewPath)
	if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
		throw new Error("preview path escapes workspace root")
	}
	if (!/\.html?$/i.test(normalized)) throw new Error("workspace preview path must be an HTML file")
	return normalized
}

async function validateWorkspacePreview(root: string, previewPath: string): Promise<string> {
	const normalized = normalizeWorkspacePreviewPath(previewPath)
	const target = resolveWorkspaceFilePath(root, normalized)
	const info = await stat(target).catch(() => null)
	if (!info?.isFile()) throw new Error("workspace preview HTML file was not found")
	return normalized
}

export function getSessionPreview(sessionId: string): SessionPreviewState | null {
	return sessionPreviews.get(normalizedSessionId(sessionId)) ?? null
}

export async function setSessionPreview(
	input: SetSessionPreviewInput,
): Promise<SessionPreviewState> {
	const sessionId = normalizedSessionId(input.sessionId)
	const root = resolveWorkspaceScope(input.root, "session preview root")
	const base = {
		sessionId,
		root,
		revision: 0,
		activationId: randomUUID(),
		updatedAt: Date.now(),
	}
	const next: SessionPreviewState =
		input.kind === "workspace"
			? { ...base, kind: "workspace", path: await validateWorkspacePreview(root, input.path) }
			: (() => {
					if (!isLoopbackPreviewUrl(input.url)) {
						throw new Error("preview URL is not an allowed loopback dev server")
					}
					return { ...base, kind: "loopback", url: new URL(input.url).toString() }
				})()
	sessionPreviews.set(sessionId, next)
	return next
}

export function reloadSessionPreview(sessionId: string): SessionPreviewState {
	const id = normalizedSessionId(sessionId)
	const current = sessionPreviews.get(id)
	if (!current) throw new Error("session preview is not active")
	const next = { ...current, revision: current.revision + 1, updatedAt: Date.now() }
	sessionPreviews.set(id, next)
	return next
}

export function clearSessionPreview(sessionId: string): boolean {
	return sessionPreviews.delete(normalizedSessionId(sessionId))
}
