import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	createProjectDirectory,
	listManagedProjects,
	listWorkspace,
	readWorkspaceText,
	writeWorkspaceText,
} from "./workspace-service"

let base = ""
let rootsBefore: string | undefined

beforeEach(async () => {
	rootsBefore = process.env.EIGENT_WORKSPACE_ROOTS
	base = await mkdtemp(path.join(os.tmpdir(), "eigent-workspace-test-"))
})

afterEach(async () => {
	if (rootsBefore === undefined) delete process.env.EIGENT_WORKSPACE_ROOTS
	else process.env.EIGENT_WORKSPACE_ROOTS = rootsBefore
	await rm(base, { recursive: true, force: true })
})

describe("project directory creation", () => {
	test("creates a project from only a name inside the configured workspace root", async () => {
		const allowedRoot = path.join(base, "workspaces")
		await mkdir(allowedRoot, { recursive: true })
		process.env.EIGENT_WORKSPACE_ROOTS = allowedRoot

		const created = await createProjectDirectory("새 프로젝트")
		expect(created.path).toBe(path.join(allowedRoot, "새 프로젝트"))
		expect((await stat(created.path)).isDirectory()).toBe(true)
	})

	test("reuses an existing managed project directory created by an older build", async () => {
		const allowedRoot = path.join(base, "workspaces")
		const existing = path.join(allowedRoot, "existing-project")
		await mkdir(existing, { recursive: true })
		process.env.EIGENT_WORKSPACE_ROOTS = allowedRoot

		const created = await createProjectDirectory("existing-project")
		expect(created.path).toBe(existing)
		expect(created.created).toBe(false)
	})

	test("lists managed project folders but excludes the internal no-project workspace", async () => {
		const allowedRoot = path.join(base, "workspaces")
		await mkdir(path.join(allowedRoot, "alpha"), { recursive: true })
		await mkdir(path.join(allowedRoot, "_no-project"), { recursive: true })
		process.env.EIGENT_WORKSPACE_ROOTS = allowedRoot

		const projects = await listManagedProjects()
		expect(projects.map((project) => project.name)).toEqual(["alpha"])
		expect(projects[0]?.worktree).toBe(path.join(allowedRoot, "alpha"))
		expect(projects[0]?.id.startsWith("workspace-")).toBe(true)
	})

	test("rejects path-shaped names instead of treating them as paths", async () => {
		const allowedRoot = path.join(base, "workspaces")
		await mkdir(allowedRoot, { recursive: true })
		process.env.EIGENT_WORKSPACE_ROOTS = allowedRoot

		await expect(createProjectDirectory("../escape")).rejects.toThrow("single folder name")
		await expect(createProjectDirectory("nested/project")).rejects.toThrow("single folder name")
	})
})

describe("workspace filesystem policy", () => {
	test("reads and writes normal Linux-style paths inside the configured root", async () => {
		const allowedRoot = path.join(base, "workspaces")
		const project = path.join(allowedRoot, "project-a")
		await mkdir(project, { recursive: true })
		process.env.EIGENT_WORKSPACE_ROOTS = allowedRoot

		await writeWorkspaceText(project, "src/hello.txt", "hello from EIGENT")
		const file = await readWorkspaceText(project, "src/hello.txt")
		expect(file.content).toBe("hello from EIGENT")
		expect(file.path).toBe("src/hello.txt")
	})

	test("maps an out-of-scope filesystem root to the safe No Project workspace", async () => {
		const allowedRoot = path.join(base, "workspaces")
		const noProject = path.join(allowedRoot, "_no-project")
		await mkdir(noProject, { recursive: true })
		await writeFile(path.join(noProject, "marker.txt"), "safe")
		process.env.EIGENT_WORKSPACE_ROOTS = allowedRoot

		const filesystemRoot = path.parse(path.resolve(base)).root
		const entries = await listWorkspace(filesystemRoot)
		expect(entries.some((entry) => entry.name === "marker.txt")).toBe(true)
		const file = await readWorkspaceText(filesystemRoot, "marker.txt")
		expect(file.content).toBe("safe")
	})

	test("rejects workspace roots outside EIGENT_WORKSPACE_ROOTS", async () => {
		const allowedRoot = path.join(base, "workspaces")
		const outside = path.join(base, "outside")
		await mkdir(allowedRoot, { recursive: true })
		await mkdir(outside, { recursive: true })
		process.env.EIGENT_WORKSPACE_ROOTS = allowedRoot

		await expect(readWorkspaceText(outside, "secret.txt")).rejects.toThrow(
			"outside EIGENT_WORKSPACE_ROOTS",
		)
	})

	const symlinkTest = process.platform === "win32" ? test.skip : test
	symlinkTest("lists symlinks but refuses to follow one outside the workspace", async () => {
		const allowedRoot = path.join(base, "workspaces")
		const project = path.join(allowedRoot, "project-a")
		const outside = path.join(base, "outside")
		await mkdir(project, { recursive: true })
		await mkdir(outside, { recursive: true })
		await writeFile(path.join(outside, "secret.txt"), "secret")
		await symlink(outside, path.join(project, "escape"), "dir")
		process.env.EIGENT_WORKSPACE_ROOTS = allowedRoot

		const entries = await listWorkspace(project)
		expect(entries.find((entry) => entry.name === "escape")?.type).toBe("symlink")
		await expect(readWorkspaceText(project, "escape/secret.txt")).rejects.toThrow(
			"through a symlink",
		)
	})
})
