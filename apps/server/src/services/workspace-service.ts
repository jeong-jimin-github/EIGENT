/** Workspace filesystem operations for the EIGENT backend. */
import { createHash } from "node:crypto"
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	assertWorkspaceAllowed,
	canonicalizePotentialPath,
	configuredWorkspaceRoots,
	pathInside,
	resolveWorkspaceScope,
} from "./workspace-policy"

export interface WorkspaceEntry {
	name: string
	path: string
	type: "file" | "directory" | "symlink" | "other"
	size: number
	modifiedAt: number
}

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024

function normalizeProjectName(name: string): string {
	const trimmed = name.trim()
	if (!trimmed) throw new Error("project name is required")
	if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
		throw new Error("project name must be a single folder name")
	}
	const hasControlCharacter = [...trimmed].some((char) => char.charCodeAt(0) < 32)
	if (/[<>:"|?*]/.test(trimmed) || hasControlCharacter || /[. ]$/.test(trimmed)) {
		throw new Error("project name contains characters that are not valid in a folder name")
	}
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(trimmed)) {
		throw new Error("project name is reserved by the operating system")
	}
	return trimmed
}

function defaultProjectRoot(): string {
	const [configuredRoot] = configuredWorkspaceRoots()
	return configuredRoot ?? path.join(os.homedir(), "EIGENT Projects")
}

export async function createProjectDirectory(name: string) {
	const projectName = normalizeProjectName(name)
	const root = defaultProjectRoot()
	await mkdir(root, { recursive: true })

	const target = path.join(root, projectName)
	assertWorkspaceAllowed(target, "project directory")
	const canonicalRoot = canonicalizePotentialPath(root)
	const canonicalTarget = canonicalizePotentialPath(target)
	if (!pathInside(canonicalRoot, canonicalTarget) || canonicalRoot === canonicalTarget) {
		throw new Error("project directory escapes the workspace root")
	}

	try {
		await mkdir(target)
		return { path: target, created: true }
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
		const existing = await stat(target).catch(() => null)
		if (!existing?.isDirectory()) {
			throw new Error("a non-directory entry with this project name already exists")
		}
		return { path: target, created: false }
	}
}

export interface ManagedWorkspaceProject {
	id: string
	worktree: string
	name: string
	time: { created: number; updated: number }
	sandboxes: string[]
}

function managedProjectId(directory: string): string {
	return `workspace-${createHash("sha256").update(directory).digest("hex").slice(0, 16)}`
}

export async function listManagedProjects(): Promise<ManagedWorkspaceProject[]> {
	const root = defaultProjectRoot()
	await mkdir(root, { recursive: true })
	const entries = await readdir(root, { withFileTypes: true })
	const projects = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory() && entry.name !== "_no-project")
			.map(async (entry) => {
				const worktree = path.join(root, entry.name)
				assertWorkspaceAllowed(worktree, "project directory")
				const info = await stat(worktree)
				return {
					id: managedProjectId(worktree),
					worktree,
					name: entry.name,
					time: { created: info.birthtimeMs || info.ctimeMs, updated: info.mtimeMs },
					sandboxes: [],
				} satisfies ManagedWorkspaceProject
			}),
	)
	return projects.toSorted(
		(a, b) => b.time.updated - a.time.updated || a.name.localeCompare(b.name),
	)
}

function normalizeRoot(root: string): string {
	return resolveWorkspaceScope(root, "workspace root")
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

export function resolveWorkspaceFilePath(root: string, relativePath = ""): string {
	return resolveInsideRoot(root, relativePath)
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
