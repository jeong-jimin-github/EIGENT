import { mkdirSync, realpathSync } from "node:fs"
import path from "node:path"

function splitCsv(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
}

export function pathInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** Resolve symlinks for the existing prefix while still supporting not-yet-created paths. */
export function canonicalizePotentialPath(input: string): string {
	const absolute = path.resolve(input)
	let probe = absolute
	const suffix: string[] = []

	while (true) {
		try {
			const resolved = realpathSync.native(probe)
			return path.resolve(resolved, ...suffix)
		} catch {
			const parent = path.dirname(probe)
			if (parent === probe) return absolute
			suffix.unshift(path.basename(probe))
			probe = parent
		}
	}
}

export function configuredWorkspaceRoots(): string[] {
	return splitCsv(process.env.EIGENT_WORKSPACE_ROOTS).map(canonicalizePotentialPath)
}

export function assertWorkspaceAllowed(input: string, label = "workspace"): string {
	if (!path.isAbsolute(input)) throw new Error(`${label} must be an absolute path`)
	const candidate = canonicalizePotentialPath(input)
	const roots = configuredWorkspaceRoots()
	if (roots.length > 0 && !roots.some((root) => pathInside(root, candidate))) {
		throw new Error(`${label} is outside EIGENT_WORKSPACE_ROOTS`)
	}
	return input
}

function isFilesystemRoot(input: string): boolean {
	if (!path.isAbsolute(input)) return false
	const resolved = path.resolve(input)
	return path.parse(resolved).root === resolved
}

/** Resolve OpenCode's global/No Project root to EIGENT's safe workspace. */
export function resolveWorkspaceScope(
	input: string | null | undefined,
	label = "workspace",
): string {
	const requested = input?.trim()
	if (!requested) return defaultNoProjectWorkspace()
	try {
		return assertWorkspaceAllowed(requested, label)
	} catch (error) {
		if (isFilesystemRoot(requested)) return defaultNoProjectWorkspace()
		throw error
	}
}

/** Safe working directory for agent runtimes launched from the UI's No Project scope. */
export function defaultNoProjectWorkspace(): string {
	const configuredRoot = configuredWorkspaceRoots()[0]
	const fallbackRoot = path.resolve(
		process.env.EIGENT_DATA_DIR ?? process.env.HOME ?? process.cwd(),
		"workspaces",
	)
	const root = configuredRoot ?? fallbackRoot
	const workspace = path.join(root, "_no-project")
	mkdirSync(workspace, { recursive: true })
	return assertWorkspaceAllowed(workspace, "default no-project workspace")
}
