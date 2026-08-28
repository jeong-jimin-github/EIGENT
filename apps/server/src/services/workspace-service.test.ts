import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { listWorkspace, readWorkspaceText, writeWorkspaceText } from "./workspace-service"

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
