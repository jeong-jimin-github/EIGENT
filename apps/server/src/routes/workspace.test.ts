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
	await writeFile(path.join(root, "_no-project", "other.html"), "<h1>Other</h1>")
})

afterEach(async () => {
	for (const sessionId of ["route-session-a", "route-session-b", "route-loopback"]) {
		await workspaceRoutes.request("/session-preview", {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId }),
		})
	}
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
		expect(["calculator.html", "other.html"]).toContain(payload.entryPath ?? "")
	})

	test("lets an agent request a Device Preview reload", async () => {
		const before = await workspaceRoutes.request("/preview-reload?root=")
		expect(before.status).toBe(200)
		const beforePayload = (await before.json()) as { revision: number }

		const response = await workspaceRoutes.request("/preview-reload", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ root: "" }),
		})
		expect(response.status).toBe(200)
		const payload = (await response.json()) as { revision: number; requestedAt: number }
		expect(payload.revision).toBe(beforePayload.revision + 1)
		expect(payload.requestedAt).toBeGreaterThan(0)

		const after = await workspaceRoutes.request("/preview-reload?root=")
		const afterPayload = (await after.json()) as { revision: number }
		expect(afterPayload.revision).toBe(payload.revision)
	})

	test("keeps agent previews isolated by UI session and persists until explicit clear", async () => {
		for (const [sessionId, previewPath] of [
			["route-session-a", "calculator.html"],
			["route-session-b", "other.html"],
		] as const) {
			const response = await workspaceRoutes.request("/session-preview", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId, root: "", kind: "workspace", path: previewPath }),
			})
			expect(response.status).toBe(200)
		}

		const firstRead = await workspaceRoutes.request("/session-preview?sessionId=route-session-a")
		const firstPayload = (await firstRead.json()) as {
			preview?: { path?: string; revision: number }
		}
		expect(firstPayload.preview?.path).toBe("calculator.html")
		expect(firstPayload.preview?.revision).toBe(0)

		const reload = await workspaceRoutes.request("/session-preview/reload", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId: "route-session-a" }),
		})
		expect(reload.status).toBe(200)
		const reloadPayload = (await reload.json()) as { revision: number }
		expect(reloadPayload.revision).toBe(1)

		const clear = await workspaceRoutes.request("/session-preview", {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId: "route-session-a" }),
		})
		expect(clear.status).toBe(200)

		const afterClear = await workspaceRoutes.request("/session-preview?sessionId=route-session-a")
		const afterClearPayload = (await afterClear.json()) as { preview?: unknown }
		expect(afterClearPayload.preview).toBeNull()

		const otherSession = await workspaceRoutes.request("/session-preview?sessionId=route-session-b")
		const otherPayload = (await otherSession.json()) as { preview?: { path?: string } }
		expect(otherPayload.preview?.path).toBe("other.html")
	})

	test("issues a loopback proxy token from stored session preview without a managed browser tab", async () => {
		const show = await workspaceRoutes.request("/session-preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				sessionId: "route-loopback",
				root: "",
				kind: "loopback",
				url: "http://127.0.0.1:5173/app",
			}),
		})
		expect(show.status).toBe(200)

		const token = await workspaceRoutes.request("/session-preview/loopback-token", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId: "route-loopback" }),
		})
		expect(token.status).toBe(201)
		const payload = (await token.json()) as { token?: string; path?: string }
		expect(payload.token?.length).toBeGreaterThan(10)
		expect(payload.path).toBe("/app")
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
