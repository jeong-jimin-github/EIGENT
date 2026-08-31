import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
	createWorkspacePreviewSession,
	findWorkspacePreviewEntry,
	resolveWorkspacePreviewAsset,
	rewritePreviewCss,
	rewritePreviewHtml,
} from "./workspace-preview"

let root = ""
let previousRoots: string | undefined

beforeEach(async () => {
	previousRoots = process.env.EIGENT_WORKSPACE_ROOTS
	root = await mkdtemp(path.join(tmpdir(), "eigent-preview-"))
	process.env.EIGENT_WORKSPACE_ROOTS = root
	await mkdir(path.join(root, "site", "styles"), { recursive: true })
	await writeFile(path.join(root, "index.html"), "<main>root</main>")
	await writeFile(path.join(root, "site", "index.html"), "<main>site</main>")
	await writeFile(path.join(root, "site", "styles", "app.css"), "body{}")
})

afterEach(async () => {
	if (previousRoots === undefined) delete process.env.EIGENT_WORKSPACE_ROOTS
	else process.env.EIGENT_WORKSPACE_ROOTS = previousRoots
	await rm(root, { recursive: true, force: true })
})

describe("workspace device preview", () => {
	test("finds the nearest HTML entry for CSS-only edits", async () => {
		expect(await findWorkspacePreviewEntry(root, ["site/styles/app.css"])).toBe("site/index.html")
	})

	test("serves only files inside the tokenized workspace", async () => {
		const preview = await createWorkspacePreviewSession(root, ["site/styles/app.css"])
		expect(preview.entryPath).toBe("site/index.html")

		const asset = await resolveWorkspacePreviewAsset(preview.token, "site/index.html")
		expect(asset.relativePath).toBe("site/index.html")
		expect(asset.absolutePath).toBe(path.join(root, "site", "index.html"))
		await expect(resolveWorkspacePreviewAsset(preview.token, "../outside.txt")).rejects.toThrow()
		await expect(resolveWorkspacePreviewAsset("invalid-token", "index.html")).rejects.toThrow(
			"invalid or expired",
		)
	})

	test("rewrites root-relative page assets into the isolated preview namespace", () => {
		const html =
			'<base href="/"><link href="/app.css"><script src="/app.js"></script><img src="//cdn/x.png">'
		const rewritten = rewritePreviewHtml(html, "token")
		expect(rewritten).toContain('<base href="/preview/token/">')
		expect(rewritten).toContain('href="/preview/token/app.css"')
		expect(rewritten).toContain('src="/preview/token/app.js"')
		expect(rewritten).toContain('src="//cdn/x.png"')
		expect(rewritePreviewCss("body{background:url(/hero.png)}", "token")).toBe(
			"body{background:url(/preview/token/hero.png)}",
		)
	})
})
