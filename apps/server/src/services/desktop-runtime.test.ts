import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DesktopRuntime, type DesktopRuntimeConfig } from "./desktop-runtime"

const temporaryDirectories: string[] = []

function runtimeConfig(sharedDir: string): DesktopRuntimeConfig {
	return {
		enabled: true,
		managed: false,
		display: ":199",
		geometry: "800x600x24",
		vncHost: "127.0.0.1",
		vncPort: 5999,
		sharedDir,
		startupTimeoutMs: 250,
	}
}

function temporaryDirectory(): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "eigent-desktop-test-"))
	temporaryDirectories.push(directory)
	return directory
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

describe("DesktopRuntime control handoff", () => {
	test("switches exclusive input ownership between agent and user", () => {
		const runtime = new DesktopRuntime(runtimeConfig(temporaryDirectory()))
		expect(runtime.getControlOwner()).toBe("agent")

		expect(runtime.takeControl()).toEqual({ controlOwner: "user", controlEpoch: 1 })
		expect(runtime.getControlOwner()).toBe("user")

		expect(runtime.returnControl()).toEqual({ controlOwner: "agent", controlEpoch: 2 })
		expect(runtime.getControlOwner()).toBe("agent")
	})
})

describe("DesktopRuntime shared files", () => {
	test("stores uploads inside the configured shared directory with a sanitized basename", () => {
		const sharedDir = temporaryDirectory()
		const runtime = new DesktopRuntime(runtimeConfig(sharedDir))
		const storedPath = runtime.storeSharedFile("../unsafe?.txt", new TextEncoder().encode("hello"))

		expect(path.dirname(storedPath)).toBe(sharedDir)
		expect(path.basename(storedPath)).toBe("unsafe_.txt")
		expect(readFileSync(storedPath, "utf8")).toBe("hello")
	})
})

describe("DesktopRuntime host support", () => {
	test("reports unsupported when the host is not Linux", async () => {
		const runtime = new DesktopRuntime(runtimeConfig(temporaryDirectory()))
		const status = await runtime.status()

		expect(status.supported).toBe(process.platform === "linux")
		if (process.platform !== "linux") {
			expect(status.state).toBe("unsupported")
			expect(status.ready).toBeFalse()
		}
	})
})
