/** Tokenized workspace preview sessions for isolated device-side rendering. */
import { randomBytes } from "node:crypto"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { resolveWorkspaceScope } from "./workspace-policy"
import { resolveWorkspaceFilePath } from "./workspace-service"

const PREVIEW_TTL_MS = 60 * 60 * 1000
const HTML_ENTRY_NAMES = ["index.html", "index.htm"] as const

interface PreviewSession {
	root: string
	expiresAt: number
	entryPath: string | null
}

const previewSessions = new Map<string, PreviewSession>()

function cleanupExpired(now = Date.now()) {
	for (const [token, session] of previewSessions) {
		if (session.expiresAt <= now) previewSessions.delete(token)
	}
}

function normalizeRelativePath(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\/+/, "")
}

function candidateEntryPaths(changedFiles: string[]): string[] {
	const candidates: string[] = []
	const seen = new Set<string>()
	const add = (candidate: string) => {
		const normalized = normalizeRelativePath(candidate)
		if (!normalized || seen.has(normalized)) return
		seen.add(normalized)
		candidates.push(normalized)
	}

	// A changed HTML file is the strongest signal, with index.html preferred.
	const htmlFiles = changedFiles
		.map(normalizeRelativePath)
		.filter((file) => /\.html?$/i.test(file))
		.toSorted((a, b) => {
			const aIndex = /(^|\/)index\.html?$/i.test(a) ? 0 : 1
			const bIndex = /(^|\/)index\.html?$/i.test(b) ? 0 : 1
			return aIndex - bIndex || a.length - b.length || a.localeCompare(b)
		})
	for (const file of htmlFiles) add(file)

	// CSS/JS-only edits should still find the nearest existing page entry.
	for (const changedFile of changedFiles.map(normalizeRelativePath)) {
		let directory = path.posix.dirname(changedFile)
		while (directory && directory !== "." && directory !== "/") {
			for (const name of HTML_ENTRY_NAMES) add(path.posix.join(directory, name))
			const parent = path.posix.dirname(directory)
			if (parent === directory) break
			directory = parent
		}
	}

	for (const name of HTML_ENTRY_NAMES) add(name)
	for (const directory of ["public", "www", "web", "static", "src"]) {
		for (const name of HTML_ENTRY_NAMES) add(path.posix.join(directory, name))
	}
	return candidates
}

export async function findWorkspacePreviewEntry(root: string, changedFiles: string[] = []) {
	const normalizedRoot = resolveWorkspaceScope(root, "workspace preview root")
	for (const candidate of candidateEntryPaths(changedFiles)) {
		try {
			const target = resolveWorkspaceFilePath(normalizedRoot, candidate)
			const info = await stat(target).catch(() => null)
			if (info?.isFile()) return candidate
		} catch {
			// Ignore malformed/out-of-root changed-file hints and continue with safe candidates.
		}
	}

	// No-project work is often not a git checkout, so it may have no diff metadata.
	// Fall back to a top-level HTML page (newest first) so a generated foo.html can
	// still activate Device Preview automatically. Keep this bounded to one directory.
	const rootEntries = await readdir(normalizedRoot, { withFileTypes: true }).catch(() => [])
	const htmlCandidates = await Promise.all(
		rootEntries
			.filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
			.slice(0, 100)
			.map(async (entry) => {
				const target = resolveWorkspaceFilePath(normalizedRoot, entry.name)
				const info = await stat(target).catch(() => null)
				return { name: entry.name, modifiedAt: info?.mtimeMs ?? 0 }
			}),
	)
	htmlCandidates.sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name))
	return htmlCandidates[0]?.name ?? null
}

export async function createWorkspacePreviewSession(root: string, changedFiles: string[] = []) {
	cleanupExpired()
	const normalizedRoot = resolveWorkspaceScope(root, "workspace preview root")
	const entryPath = await findWorkspacePreviewEntry(normalizedRoot, changedFiles)
	const token = randomBytes(24).toString("base64url")
	const expiresAt = Date.now() + PREVIEW_TTL_MS
	previewSessions.set(token, { root: normalizedRoot, expiresAt, entryPath })
	return { token, expiresAt, entryPath }
}

function requirePreviewSession(token: string): PreviewSession {
	cleanupExpired()
	const session = previewSessions.get(token)
	if (!session) throw new Error("workspace preview session is invalid or expired")
	session.expiresAt = Date.now() + PREVIEW_TTL_MS
	return session
}

function cleanRequestPath(requestPath: string, fallbackPath: string): string {
	const decoded = decodeURIComponent(requestPath)
	const normalized = normalizeRelativePath(decoded)
	return normalized || fallbackPath
}

export async function resolveWorkspacePreviewAsset(token: string, requestPath: string) {
	const session = requirePreviewSession(token)
	let relativePath = cleanRequestPath(requestPath, session.entryPath ?? "index.html")
	let target = resolveWorkspaceFilePath(session.root, relativePath)
	let info = await stat(target).catch(() => null)

	if (info?.isDirectory()) {
		relativePath = path.posix.join(relativePath, "index.html")
		target = resolveWorkspaceFilePath(session.root, relativePath)
		info = await stat(target).catch(() => null)
	}

	// SPA-friendly fallback for extensionless navigations.
	if ((!info || !info.isFile()) && !path.posix.extname(relativePath)) {
		relativePath = "index.html"
		target = resolveWorkspaceFilePath(session.root, relativePath)
		info = await stat(target).catch(() => null)
	}

	if (!info?.isFile()) throw new Error("workspace preview asset was not found")
	return { absolutePath: target, relativePath, size: info.size, modifiedAt: info.mtimeMs }
}

export function rewritePreviewHtml(html: string, token: string): string {
	const prefix = `/preview/${token}/`
	return html
		.replace(/\b(src|href|action)(\s*=\s*["'])\/(?!\/)/gi, (_match, attribute, separator) => {
			return `${attribute}${separator}${prefix}`
		})
		.replace(/url\((\s*["']?)\/(?!\/)/gi, (_match, quote) => `url(${quote}${prefix}`)
}

export function rewritePreviewCss(css: string, token: string): string {
	const prefix = `/preview/${token}/`
	return css.replace(/url\((\s*["']?)\/(?!\/)/gi, (_match, quote) => `url(${quote}${prefix}`)
}
