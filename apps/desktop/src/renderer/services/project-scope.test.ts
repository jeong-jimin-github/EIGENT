import { describe, expect, test } from "bun:test"
import type { OpenCodeProject } from "../lib/types"
import {
	buildProjectScopeMappings,
	logicalProjectDirectory,
	logicalWorkspaceDirectory,
} from "./project-scope"

const project = (worktree: string, sandboxes: string[] = []): OpenCodeProject =>
	({ id: `id-${worktree}`, worktree, sandboxes, time: { created: 0, updated: 0 } }) as OpenCodeProject

describe("project scope normalization", () => {
	test("absorbs an orphan legacy directory into No Project after discovery", () => {
		const mappings = buildProjectScopeMappings([project("/safe/app")], true)
		expect(logicalProjectDirectory("/home/ubuntu", mappings)).toBe("")
		expect(logicalWorkspaceDirectory("/home/ubuntu", mappings)).toBe("")
	})

	test("keeps discovered projects and sandbox workspaces intact", () => {
		const mappings = buildProjectScopeMappings([project("/safe/app", ["/safe/app-worktree"])], true)
		expect(logicalProjectDirectory("/safe/app", mappings)).toBe("/safe/app")
		expect(logicalWorkspaceDirectory("/safe/app", mappings)).toBe("/safe/app")
		expect(logicalProjectDirectory("/safe/app-worktree", mappings)).toBe("/safe/app")
		expect(logicalWorkspaceDirectory("/safe/app-worktree", mappings)).toBe("/safe/app-worktree")
	})

	test("does not remap before discovery is complete", () => {
		const mappings = buildProjectScopeMappings([], false)
		expect(logicalProjectDirectory("/pending/project", mappings)).toBe("/pending/project")
		expect(logicalWorkspaceDirectory("/pending/project", mappings)).toBe("/pending/project")
	})
})
