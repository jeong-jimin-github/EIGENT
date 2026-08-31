import { describe, expect, test } from "bun:test"
import type { FileDiff } from "../lib/types"
import {
	devicePreviewUrl,
	hasWebPreviewChanges,
	isLoopbackPreviewUrl,
	loopbackPreviewUrl,
	webPreviewChangedFiles,
	webPreviewRevision,
} from "./device-preview"

function diff(file: string, after: string): FileDiff {
	return { file, before: "", after, additions: 1, deletions: 0 }
}

describe("device preview diff detection", () => {
	test("recognizes webpage source changes and filters non-web files", () => {
		const diffs = [diff("README.md", "docs"), diff("src/App.tsx", "export default 1"), diff("style.css", "body{}")]
		expect(hasWebPreviewChanges(diffs)).toBe(true)
		expect(webPreviewChangedFiles(diffs)).toEqual(["src/App.tsx", "style.css"])
		expect(hasWebPreviewChanges([diff("README.md", "docs")])).toBe(false)
		expect(hasWebPreviewChanges([diff("src/server.ts", "export const port = 1")])).toBe(false)
	})

	test("changes the reload revision when webpage output changes", () => {
		const before = webPreviewRevision([diff("index.html", "<h1>A</h1>")])
		const after = webPreviewRevision([diff("index.html", "<h1>B</h1>")])
		expect(before).not.toBe(after)
	})

	test("builds a tokenized same-origin iframe URL with encoded path segments", () => {
		expect(devicePreviewUrl("abc", "pages/한글 page.html", "r1")).toBe(
			"/preview/abc/pages/%ED%95%9C%EA%B8%80%20page.html?v=r1",
		)
	})

	test("recognizes loopback dev servers and builds their proxy iframe URL", () => {
		expect(isLoopbackPreviewUrl("http://127.0.0.1:5173/app")).toBe(true)
		expect(isLoopbackPreviewUrl("https://example.com/")).toBe(false)
		expect(loopbackPreviewUrl("tok", "/app?q=1", "rev 2")).toBe(
			"/local-preview/tok/app?q=1&eigent_preview_revision=rev+2",
		)
	})
})
