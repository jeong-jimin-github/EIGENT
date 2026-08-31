import type { OpenCodeProject } from "../lib/types"

export interface ProjectScopeMappings {
	discoveryLoaded: boolean
	knownProjectDirectories: Set<string>
	sandboxToParent: Map<string, string>
}

export function buildProjectScopeMappings(
	projects: OpenCodeProject[],
	discoveryLoaded: boolean,
): ProjectScopeMappings {
	const knownProjectDirectories = new Set<string>()
	const sandboxToParent = new Map<string, string>()
	for (const project of projects) {
		if (!project.worktree) continue
		knownProjectDirectories.add(project.worktree)
		for (const sandbox of project.sandboxes ?? []) sandboxToParent.set(sandbox, project.worktree)
	}
	return { discoveryLoaded, knownProjectDirectories, sandboxToParent }
}

/** Project/sidebar directory. Orphan legacy scopes become No Project after discovery. */
export function logicalProjectDirectory(directory: string, mappings: ProjectScopeMappings): string {
	if (!directory) return ""
	const parent = mappings.sandboxToParent.get(directory)
	if (parent) return parent
	if (!mappings.discoveryLoaded) return directory
	return mappings.knownProjectDirectories.has(directory) ? directory : ""
}

/** Workspace used by tools and Device Preview. Sandboxes keep their own worktree. */
export function logicalWorkspaceDirectory(directory: string, mappings: ProjectScopeMappings): string {
	if (!directory) return ""
	if (mappings.sandboxToParent.has(directory)) return directory
	if (!mappings.discoveryLoaded) return directory
	return mappings.knownProjectDirectories.has(directory) ? directory : ""
}
