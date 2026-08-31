import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { getDevicePreviewReloadState, requestDevicePreviewReload } from "./device-preview-control"

let root = ""
let previousRoots: string | undefined
let previousDataDir: string | undefined

beforeEach(async () => {
	previousRoots = process.env.EIGENT_WORKSPACE_ROOTS
	previousDataDir = process.env.EIGENT_DATA_DIR
	root = await mkdtemp(path.join(tmpdir(), "eigent-preview-reload-"))
	process.env.EIGENT_WORKSPACE_ROOTS = root
	process.env.EIGENT_DATA_DIR = path.join(root, ".data")
	await mkdir(path.join(root, "_no-project"), { recursive: true })
})

afterEach(async () => {
	if (previousRoots === undefined) delete process.env.EIGENT_WORKSPACE_ROOTS
	else process.env.EIGENT_WORKSPACE_ROOTS = previousRoots
	if (previousDataDir === undefined) delete process.env.EIGENT_DATA_DIR
	else process.env.EIGENT_DATA_DIR = previousDataDir
	await rm(root, { recursive: true, force: true })
})

describe("device preview reload control", () => {
	test("increments a workspace-scoped reload revision", () => {
		const initial = getDevicePreviewReloadState("")
		const first = requestDevicePreviewReload("")
		const second = requestDevicePreviewReload("")
		expect(initial.revision).toBe(0)
		expect(first.revision).toBe(1)
		expect(second.revision).toBe(2)
		expect(second.root).toBe(path.join(root, "_no-project"))
		expect(second.requestedAt).toBeGreaterThan(0)
	})

	test("keeps different project workspaces isolated", async () => {
		const project = path.join(root, "project-a")
		await mkdir(project, { recursive: true })
		expect(requestDevicePreviewReload(project).revision).toBe(1)
		expect(getDevicePreviewReloadState("").revision).toBe(0)
	})
})
