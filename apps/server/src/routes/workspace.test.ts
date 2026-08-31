import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import workspaceRoutes from "./workspace"

let root = ""
let previousRoots: string | undefined
let previousDataDir: string | undefined

beforeEach(async () => {
	previousRoots = process.env.EIGENT_WORKSPACE_ROOTS
	previousDataDir = process.env.EIGENT_DATA_DIR
	root = await mkdtemp(path.join(tmpdir(), "eigent-workspace-route-"))
	process.env.EIGENT_WORKSPACE_ROOTS = root
	process.env.EIGENT_DATA_DIR = path.join(root, ".data")
	await mkdir(path.join(root, "_no-project"), { recursive: true })
	await writeFile(path.join(root, "_no-project", "calculator.html"), "<h1>Calculator</h1>")
})

afterEach(async () => {
	if (previousRoots === undefined) delete process.env.EIGENT_WORKSPACE_ROOTS
	else process.env.EIGENT_WORKSPACE_ROOTS = previousRoots
	if (previousDataDir === undefined) delete process.env.EIGENT_DATA_DIR
	else process.env.EIGENT_DATA_DIR = previousDataDir
	await rm(root, { recursive: true, force: true })
})

describe("workspace routes", () => {
	test("accepts the empty logical root for No Project previews", async () => {
		const response = await workspaceRoutes.request("/preview-token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ root: "", changedFiles: ["calculator.html"] }),
		})
		expect(response.status).toBe(201)
		const payload = (await response.json()) as { entryPath?: string }
		expect(payload.entryPath).toBe("calculator.html")
	})

	test("discovers a No Project HTML page without diff metadata", async () => {
		const response = await workspaceRoutes.request("/preview-entry?root=")
		expect(response.status).toBe(200)
		const payload = (await response.json()) as { entryPath?: string }
		expect(payload.entryPath).toBe("calculator.html")
	})
	test("supports No Project file CRUD through the empty logical root", async () => {
		const listResponse = await workspaceRoutes.request("/list?root=&path=")
		expect(listResponse.status).toBe(200)
		const listPayload = (await listResponse.json()) as { entries: Array<{ name: string }> }
		expect(listPayload.entries.some((entry) => entry.name === "calculator.html")).toBe(true)

		const readResponse = await workspaceRoutes.request("/read?root=&path=calculator.html")
		expect(readResponse.status).toBe(200)
		const readPayload = (await readResponse.json()) as { content: string }
		expect(readPayload.content).toContain("Calculator")

		const writeResponse = await workspaceRoutes.request("/write", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ root: "", path: "notes.txt", content: "hello no-project" }),
		})
		expect(writeResponse.status).toBe(200)

		const mkdirResponse = await workspaceRoutes.request("/mkdir", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ root: "", path: "nested" }),
		})
		expect(mkdirResponse.status).toBe(200)

		const renameResponse = await workspaceRoutes.request("/rename", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ root: "", from: "notes.txt", to: "nested/notes.txt" }),
		})
		expect(renameResponse.status).toBe(200)

		const movedRead = await workspaceRoutes.request("/read?root=&path=nested%2Fnotes.txt")
		expect(movedRead.status).toBe(200)
		const movedPayload = (await movedRead.json()) as { content: string }
		expect(movedPayload.content).toBe("hello no-project")

		const deleteResponse = await workspaceRoutes.request("/path", {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ root: "", path: "nested" }),
		})
		expect(deleteResponse.status).toBe(200)
	})
})
