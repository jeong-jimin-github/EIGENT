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

	test("caches browser executable discovery across status polls", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "eigent-browser-status-cache-"))
		let discoveryCalls = 0
		try {
			const runtime = new BrowserRuntime(
				{
					profileDir: path.join(root, "profile"),
					downloadDir: path.join(root, "downloads"),
					uploadDir: path.join(root, "uploads"),
					debugPort: 19423,
					workerPort: 19424,
					headless: true,
					startupTimeoutMs: 1000,
				},
				() => {
					discoveryCalls++
					return process.execPath
				},
			)

			expect((await runtime.status()).executablePath).toBe(process.execPath)
			expect((await runtime.status()).executablePath).toBe(process.execPath)
			expect(discoveryCalls).toBe(1)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test("reports a runtime disconnect after a previously healthy status", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "eigent-browser-disconnect-"))
		const cdp = Bun.serve({
			port: 0,
			fetch: () => Response.json({ Browser: "test" }),
		})
		const worker = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/health") {
					return Response.json({ service: "eigent-browser-worker" })
				}
				return Response.json({ tabs: [] })
			},
		})

		try {
			if (cdp.port === undefined || worker.port === undefined) {
				throw new Error("Test servers did not bind to a port")
			}
			const runtime = new BrowserRuntime({
				profileDir: path.join(root, "profile"),
				downloadDir: path.join(root, "downloads"),
				uploadDir: path.join(root, "uploads"),
				debugPort: cdp.port,
				workerPort: worker.port,
				headless: true,
				startupTimeoutMs: 1000,
			})

			const healthy = await runtime.status()
			expect(healthy.state).toBe("ready")
			expect(healthy.connected).toBeTrue()
			expect(healthy.lastError).toBeUndefined()

			worker.stop(true)
			const disconnected = await runtime.status()
			expect(disconnected.state).toBe("error")
			expect(disconnected.connected).toBeFalse()
			expect(disconnected.lastError).toContain("Browser worker disconnected")
		} finally {
			cdp.stop(true)
			worker.stop(true)
			rmSync(root, { recursive: true, force: true })
		}
	})

	test("drops stale managed PIDs from status", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "eigent-browser-stale-pid-"))
		try {
			const runtime = new BrowserRuntime(
				{
					profileDir: path.join(root, "profile"),
					downloadDir: path.join(root, "downloads"),
					uploadDir: path.join(root, "uploads"),
					debugPort: 19623,
					workerPort: 19624,
					headless: true,
					startupTimeoutMs: 30,
				},
				() => process.execPath,
				() => {},
				() => false,
			)
			Object.assign(runtime, { spawnedPid: 12345, workerPid: 23456 })

			const status = await runtime.status()
			expect(status.spawnedPid).toBeUndefined()
			expect(status.workerPid).toBeUndefined()
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test("cleans up only processes launched by a failed startup attempt", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "eigent-browser-startup-cleanup-"))
		const terminated: number[] = []
		try {
			const runtime = new BrowserRuntime(
				{
					profileDir: path.join(root, "profile"),
					downloadDir: path.join(root, "downloads"),
					uploadDir: path.join(root, "uploads"),
					debugPort: 19523,
					workerPort: 19524,
					headless: true,
					startupTimeoutMs: 30,
				},
				() => process.execPath,
				(pid) => terminated.push(pid),
			)

			await expect(runtime.ensureReady()).rejects.toThrow("Browser CDP")
			expect(terminated).toHaveLength(1)
			expect(terminated[0]).toBeGreaterThan(0)

			const status = await runtime.status()
			expect(status.state).toBe("error")
			expect(status.connected).toBeFalse()
			expect(status.spawnedPid).toBeUndefined()
			expect(status.workerPid).toBeUndefined()
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
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
