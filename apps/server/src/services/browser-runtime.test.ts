import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
	BrowserRuntime,
	discoverBrowserExecutable,
	loadBrowserRuntimeConfig,
} from "./browser-runtime"

describe("browser runtime", () => {
	test("uses stable profile/download/upload directories", () => {
		const previous = process.env.EIGENT_DATA_DIR
		process.env.EIGENT_DATA_DIR = path.resolve(".tmp-eigent-browser-test")
		try {
			const config = loadBrowserRuntimeConfig()
			expect(config.profileDir).toEndWith(path.join("browser", "profile"))
			expect(config.downloadDir).toEndWith(path.join("browser", "downloads"))
			expect(config.uploadDir).toEndWith(path.join("browser", "uploads"))
			expect(config.workerPort).toBe(config.debugPort + 1)
		} finally {
			if (previous === undefined) delete process.env.EIGENT_DATA_DIR
			else process.env.EIGENT_DATA_DIR = previous
		}
	})

	test("can reopen an already-created persistent directory layout", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "eigent-browser-reopen-"))
		const config = {
			profileDir: path.join(root, "profile"),
			downloadDir: path.join(root, "downloads"),
			uploadDir: path.join(root, "uploads"),
			debugPort: 19323,
			workerPort: 19324,
			headless: true,
			startupTimeoutMs: 1000,
		}
		try {
			expect(() => new BrowserRuntime(config)).not.toThrow()
			expect(() => new BrowserRuntime(config)).not.toThrow()
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test("does not accept a missing explicit browser executable", () => {
		expect(discoverBrowserExecutable(path.resolve("missing-browser.exe"))).toBeUndefined()
	})

	test("sanitizes download filenames into the configured directory", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "eigent-browser-unit-"))
		try {
			const runtime = new BrowserRuntime({
				profileDir: path.join(root, "profile"),
				downloadDir: path.join(root, "downloads"),
				uploadDir: path.join(root, "uploads"),
				debugPort: 19223,
				workerPort: 19224,
				headless: true,
				startupTimeoutMs: 1000,
			})
			expect(runtime.resolveDownloadPath("../escape.txt")).toBe(
				path.join(root, "downloads", "escape.txt"),
			)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})
