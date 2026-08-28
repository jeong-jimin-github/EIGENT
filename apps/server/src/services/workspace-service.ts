/** Workspace filesystem operations for the EIGENT backend. */
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { assertWorkspaceAllowed, canonicalizePotentialPath, pathInside } from "./workspace-policy"

export interface WorkspaceEntry {
	name: string
	path: string
	type: "file" | "directory" | "symlink" | "other"
	size: number
	modifiedAt: number
}

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024

function normalizeRoot(root: string): string {
	return assertWorkspaceAllowed(root, "workspace root")
}

function resolveInsideRoot(root: string, relativePath = ""): string {
	const normalizedRoot = normalizeRoot(root)
	const candidate = path.resolve(normalizedRoot, relativePath)
	if (!pathInside(normalizedRoot, candidate)) throw new Error("path escapes workspace root")

	const canonicalRoot = canonicalizePotentialPath(normalizedRoot)
	const canonicalCandidate = canonicalizePotentialPath(candidate)
	if (!pathInside(canonicalRoot, canonicalCandidate)) {
		throw new Error("path escapes workspace root through a symlink")
	}
	return candidate
}

function relativeFromRoot(root: string, target: string): string {
	return path.relative(normalizeRoot(root), target).split(path.sep).join("/")
}

export async function listWorkspace(root: string, relativePath = ""): Promise<WorkspaceEntry[]> {
	const target = resolveInsideRoot(root, relativePath)
	const entries = await readdir(target, { withFileTypes: true })
	const results = await Promise.all(
		entries.map(async (entry) => {
			const absolute = path.join(target, entry.name)
			const info = await lstat(absolute)
			const type: WorkspaceEntry["type"] = entry.isDirectory()
				? "directory"
				: entry.isFile()
					? "file"
					: entry.isSymbolicLink()
						? "symlink"
						: "other"
			return {
				name: entry.name,
				path: relativeFromRoot(root, absolute),
				type,
				size: info.size,
				modifiedAt: info.mtimeMs,
			} satisfies WorkspaceEntry
		}),
	)

	return results.toSorted((a, b) => {
		if (a.type === "directory" && b.type !== "directory") return -1
		if (a.type !== "directory" && b.type === "directory") return 1
		return a.name.localeCompare(b.name)
	})
}

export async function readWorkspaceText(root: string, relativePath: string) {
	const target = resolveInsideRoot(root, relativePath)
	const info = await stat(target)
	if (!info.isFile()) throw new Error("path is not a file")
	if (info.size > MAX_TEXT_FILE_BYTES) {
		throw new Error(`file exceeds ${MAX_TEXT_FILE_BYTES} byte text preview limit`)
	}
	const content = await readFile(target, "utf8")
	return {
		path: relativeFromRoot(root, target),
		content,
		size: info.size,
		modifiedAt: info.mtimeMs,
	}
}

export async function writeWorkspaceText(root: string, relativePath: string, content: string) {
	const target = resolveInsideRoot(root, relativePath)
	await mkdir(path.dirname(target), { recursive: true })
	await writeFile(target, content, "utf8")
	const info = await stat(target)
	return { path: relativeFromRoot(root, target), size: info.size, modifiedAt: info.mtimeMs }
}

export async function createWorkspaceDirectory(root: string, relativePath: string) {
	const target = resolveInsideRoot(root, relativePath)
	await mkdir(target, { recursive: true })
	return { path: relativeFromRoot(root, target) }
}

export async function deleteWorkspacePath(root: string, relativePath: string) {
	if (!relativePath.trim()) throw new Error("refusing to delete workspace root")
	const target = resolveInsideRoot(root, relativePath)
	await rm(target, { recursive: true, force: false })
	return { deleted: relativeFromRoot(root, target) }
}

export async function renameWorkspacePath(root: string, from: string, to: string) {
	if (!from.trim() || !to.trim()) throw new Error("from and to are required")
	const source = resolveInsideRoot(root, from)
	const destination = resolveInsideRoot(root, to)
	await mkdir(path.dirname(destination), { recursive: true })
	await rename(source, destination)
	return { from: relativeFromRoot(root, source), to: relativeFromRoot(root, destination) }
}
