import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
	clearSessionPreview,
	getSessionPreview,
	reloadSessionPreview,
	setSessionPreview,
} from "./session-preview"

let root = ""
let previousRoots: string | undefined

beforeEach(async () => {
	previousRoots = process.env.EIGENT_WORKSPACE_ROOTS
	root = await mkdtemp(path.join(tmpdir(), "eigent-session-preview-"))
	process.env.EIGENT_WORKSPACE_ROOTS = root
	await mkdir(path.join(root, "pages"), { recursive: true })
	await writeFile(path.join(root, "pages", "a.html"), "<h1>A</h1>")
	await writeFile(path.join(root, "pages", "b.html"), "<h1>B</h1>")
})

afterEach(async () => {
	clearSessionPreview("session-a")
	clearSessionPreview("session-b")
	if (previousRoots === undefined) delete process.env.EIGENT_WORKSPACE_ROOTS
	else process.env.EIGENT_WORKSPACE_ROOTS = previousRoots
	await rm(root, { recursive: true, force: true })
})

describe("session preview state", () => {
	test("keeps independent explicit previews for each UI session until cleared", async () => {
		const first = await setSessionPreview({
			sessionId: "session-a",
			root,
			kind: "workspace",
			path: "pages/a.html",
		})
		const second = await setSessionPreview({
			sessionId: "session-b",
			root,
			kind: "workspace",
			path: "pages/b.html",
		})

		expect(getSessionPreview("session-a")).toMatchObject({
			kind: "workspace",
			path: "pages/a.html",
		})
		expect(getSessionPreview("session-b")).toMatchObject({
			kind: "workspace",
			path: "pages/b.html",
		})

		const reloaded = reloadSessionPreview("session-a")
		expect(reloaded.revision).toBe(1)
		expect(reloaded.activationId).toBe(first.activationId)
		expect(getSessionPreview("session-b")?.revision).toBe(second.revision)

		expect(clearSessionPreview("session-a")).toBe(true)
		expect(getSessionPreview("session-a")).toBeNull()
		expect(getSessionPreview("session-b")).not.toBeNull()
	})

	test("re-showing a preview creates a new activation while reload does not", async () => {
		const first = await setSessionPreview({
			sessionId: "session-a",
			root,
			kind: "workspace",
			path: "pages/a.html",
		})
		const reloaded = reloadSessionPreview("session-a")
		const shownAgain = await setSessionPreview({
			sessionId: "session-a",
			root,
			kind: "workspace",
			path: "pages/a.html",
		})

		expect(reloaded.activationId).toBe(first.activationId)
		expect(shownAgain.activationId).not.toBe(first.activationId)
		expect(shownAgain.revision).toBe(0)
	})

	test("validates explicit workspace paths and loopback URLs", async () => {
		await expect(
			setSessionPreview({ sessionId: "session-a", root, kind: "workspace", path: "missing.html" }),
		).rejects.toThrow("was not found")
		await expect(
			setSessionPreview({
				sessionId: "session-a",
				root,
				kind: "workspace",
				path: "../outside.html",
			}),
		).rejects.toThrow("escapes workspace root")
		await expect(
			setSessionPreview({
				sessionId: "session-a",
				root,
				kind: "loopback",
				url: "https://example.com/",
			}),
		).rejects.toThrow("allowed loopback")

		const loopback = await setSessionPreview({
			sessionId: "session-a",
			root,
			kind: "loopback",
			url: "http://127.0.0.1:5173/app",
		})
		expect(loopback).toMatchObject({ kind: "loopback", url: "http://127.0.0.1:5173/app" })
	})
})
