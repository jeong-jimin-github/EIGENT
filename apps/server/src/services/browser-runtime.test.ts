import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
	BrowserRuntime,
	browserIdleTimeoutMs,
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
			idleTimeoutMs: 0,
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

	test("uses a 60 second browser idle timeout only on low-memory hosts by default", () => {
		const previousLowMemory = process.env.EIGENT_BROWSER_LOW_MEMORY
		const previousIdleTimeout = process.env.EIGENT_BROWSER_IDLE_TIMEOUT_MS
		try {
			delete process.env.EIGENT_BROWSER_IDLE_TIMEOUT_MS
			process.env.EIGENT_BROWSER_LOW_MEMORY = "true"
			expect(browserIdleTimeoutMs()).toBe(60_000)
			process.env.EIGENT_BROWSER_LOW_MEMORY = "false"
			expect(browserIdleTimeoutMs()).toBe(0)
			process.env.EIGENT_BROWSER_IDLE_TIMEOUT_MS = "250"
			expect(browserIdleTimeoutMs()).toBe(250)
			process.env.EIGENT_BROWSER_IDLE_TIMEOUT_MS = "0"
			expect(browserIdleTimeoutMs()).toBe(0)
		} finally {
			if (previousLowMemory === undefined) delete process.env.EIGENT_BROWSER_LOW_MEMORY
			else process.env.EIGENT_BROWSER_LOW_MEMORY = previousLowMemory
			if (previousIdleTimeout === undefined) delete process.env.EIGENT_BROWSER_IDLE_TIMEOUT_MS
			else process.env.EIGENT_BROWSER_IDLE_TIMEOUT_MS = previousIdleTimeout
		}
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
					idleTimeoutMs: 0,
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
				idleTimeoutMs: 0,
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
					idleTimeoutMs: 0,
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
					idleTimeoutMs: 0,
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

	test("stops managed browser children after the configured idle timeout", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "eigent-browser-idle-"))
		const terminated: number[] = []
		const cdp = Bun.serve({ port: 0, fetch: () => Response.json({ Browser: "test" }) })
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
			if (cdp.port === undefined || worker.port === undefined)
				throw new Error("Test port unavailable")
			const runtime = new BrowserRuntime(
				{
					profileDir: path.join(root, "profile"),
					downloadDir: path.join(root, "downloads"),
					uploadDir: path.join(root, "uploads"),
					debugPort: cdp.port,
					workerPort: worker.port,
					headless: true,
					startupTimeoutMs: 1000,
					idleTimeoutMs: 20,
				},
				() => process.execPath,
				(pid) => terminated.push(pid),
				() => true,
			)
			Object.assign(runtime, { spawnedPid: 11111, workerPid: 22222 })
			await runtime.ensureReady()
			await new Promise((resolve) => setTimeout(resolve, 60))
			expect(terminated).toEqual([22222, 11111])
			const internal = runtime as unknown as {
				spawnedPid?: number
				workerPid?: number
				state: string
			}
			expect(internal.spawnedPid).toBeUndefined()
			expect(internal.workerPid).toBeUndefined()
			expect(internal.state).toBe("idle")
		} finally {
			cdp.stop(true)
			worker.stop(true)
			rmSync(root, { recursive: true, force: true })
		}
	})

	test("does not idle-stop the browser while an action is in flight", async () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "eigent-browser-active-"))
		const terminated: number[] = []
		const cdp = Bun.serve({ port: 0, fetch: () => Response.json({ Browser: "test" }) })
		const worker = Bun.serve({
			port: 0,
			async fetch(request) {
				const pathname = new URL(request.url).pathname
				if (pathname === "/health") return Response.json({ service: "eigent-browser-worker" })
				if (pathname === "/action") {
					await new Promise((resolve) => setTimeout(resolve, 60))
					return Response.json({ result: { ok: true } })
				}
				return Response.json({ tabs: [] })
			},
		})
		try {
			if (cdp.port === undefined || worker.port === undefined)
				throw new Error("Test port unavailable")
			const runtime = new BrowserRuntime(
				{
					profileDir: path.join(root, "profile"),
					downloadDir: path.join(root, "downloads"),
					uploadDir: path.join(root, "uploads"),
					debugPort: cdp.port,
					workerPort: worker.port,
					headless: true,
					startupTimeoutMs: 1000,
					idleTimeoutMs: 20,
				},
				() => process.execPath,
				(pid) => terminated.push(pid),
				() => true,
			)
			Object.assign(runtime, { spawnedPid: 33333, workerPid: 44444 })
			const action = runtime.action({ action: "tabs" })
			await new Promise((resolve) => setTimeout(resolve, 35))
			expect(terminated).toHaveLength(0)
			await action
			await new Promise((resolve) => setTimeout(resolve, 45))
			expect(terminated).toEqual([44444, 33333])
		} finally {
			cdp.stop(true)
			worker.stop(true)
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
				idleTimeoutMs: 0,
			})
			expect(runtime.resolveDownloadPath("../escape.txt")).toBe(
				path.join(root, "downloads", "escape.txt"),
			)
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})
})
