import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
	DesktopRuntime,
	type DesktopRuntimeConfig,
	desktopIdleTimeoutMs,
	reconcileDesktopRuntimeState,
} from "./desktop-runtime"

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
		idleTimeoutMs: 0,
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

describe("DesktopRuntime low-memory lifecycle", () => {
	test("uses a 60 second idle timeout only on low-memory hosts by default", () => {
		const previousLowMemory = process.env.EIGENT_BROWSER_LOW_MEMORY
		const previousIdleTimeout = process.env.EIGENT_DESKTOP_IDLE_TIMEOUT_MS
		try {
			delete process.env.EIGENT_DESKTOP_IDLE_TIMEOUT_MS
			process.env.EIGENT_BROWSER_LOW_MEMORY = "true"
			expect(desktopIdleTimeoutMs()).toBe(60_000)
			process.env.EIGENT_BROWSER_LOW_MEMORY = "false"
			expect(desktopIdleTimeoutMs()).toBe(0)
			process.env.EIGENT_DESKTOP_IDLE_TIMEOUT_MS = "250"
			expect(desktopIdleTimeoutMs()).toBe(250)
			process.env.EIGENT_DESKTOP_IDLE_TIMEOUT_MS = "0"
			expect(desktopIdleTimeoutMs()).toBe(0)
		} finally {
			if (previousLowMemory === undefined) delete process.env.EIGENT_BROWSER_LOW_MEMORY
			else process.env.EIGENT_BROWSER_LOW_MEMORY = previousLowMemory
			if (previousIdleTimeout === undefined) delete process.env.EIGENT_DESKTOP_IDLE_TIMEOUT_MS
			else process.env.EIGENT_DESKTOP_IDLE_TIMEOUT_MS = previousIdleTimeout
		}
	})

	test("caches command discovery until an explicit refresh", () => {
		let calls = 0
		const runtime = new DesktopRuntime(runtimeConfig(temporaryDirectory()), (command) => {
			calls += 1
			return `/fake/${command}`
		})
		const internal = runtime as unknown as {
			commandExecutable(command: string, refresh?: boolean): string | undefined
		}
		expect(internal.commandExecutable("xdpyinfo")).toBe("/fake/xdpyinfo")
		expect(internal.commandExecutable("xdpyinfo")).toBe("/fake/xdpyinfo")
		expect(calls).toBe(1)
		expect(internal.commandExecutable("xdpyinfo", true)).toBe("/fake/xdpyinfo")
		expect(calls).toBe(2)
	})

	test("keeps managed desktop children alive while an activity lease is held", async () => {
		const config = { ...runtimeConfig(temporaryDirectory()), managed: true, idleTimeoutMs: 20 }
		const runtime = new DesktopRuntime(config)
		const killed: string[] = []
		const internal = runtime as unknown as {
			children: Map<string, { pid: number; kill(signal?: NodeJS.Signals): boolean }>
		}
		internal.children.set("xvfb", {
			pid: 4242,
			kill(signal) {
				killed.push(String(signal))
				return true
			},
		})

		const release = runtime.acquireActivityLease()
		await new Promise((resolve) => setTimeout(resolve, 45))
		expect(killed).toHaveLength(0)
		release()
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(killed).toEqual(["SIGTERM"])
	})
})

describe("DesktopRuntime status reconciliation", () => {
	test("reports a previously ready runtime as errored after X or VNC disconnects", () => {
		expect(reconcileDesktopRuntimeState("ready", true, false, true)).toBe("error")
		expect(reconcileDesktopRuntimeState("ready", true, true, false)).toBe("error")
		expect(reconcileDesktopRuntimeState("ready", true, false, false)).toBe("error")
	})

	test("preserves intentional idle and startup states while disconnected", () => {
		expect(reconcileDesktopRuntimeState("idle", true, false, false)).toBe("idle")
		expect(reconcileDesktopRuntimeState("starting", true, false, false)).toBe("starting")
		expect(reconcileDesktopRuntimeState("error", true, false, false)).toBe("error")
	})

	test("moves a recovered runtime back to ready and unsupported hosts to unsupported", () => {
		expect(reconcileDesktopRuntimeState("error", true, true, true)).toBe("ready")
		expect(reconcileDesktopRuntimeState("idle", false, false, false)).toBe("unsupported")
	})
})

describe("DesktopRuntime passive health", () => {
	test("cleans up sibling managed children after an unexpected child exit", () => {
		const runtime = new DesktopRuntime({
			...runtimeConfig(temporaryDirectory()),
			managed: true,
			idleTimeoutMs: 0,
		})
		const killed: number[] = []
		const fakeChild = (pid: number) => ({
			pid,
			kill() {
				killed.push(pid)
				return true
			},
		})
		const internal = runtime as unknown as {
			state: import("./desktop-runtime").DesktopRuntimeState
			lastError?: string
			children: Map<string, ReturnType<typeof fakeChild>>
			handleUnexpectedChildExit(kind: "xvfb" | "openbox" | "x11vnc"): void
		}
		internal.children.set("xvfb", fakeChild(4301))
		internal.children.set("openbox", fakeChild(4302))
		internal.children.set("x11vnc", fakeChild(4303))
		internal.state = "ready"
		internal.children.delete("x11vnc")

		internal.handleUnexpectedChildExit("x11vnc")

		expect(String(internal.state)).toBe("error")
		expect(internal.lastError).toContain("x11vnc")
		expect(killed.sort()).toEqual([4301, 4302])
		expect(internal.children.size).toBe(0)
	})

	test("uses cached dependency discovery for repeated managed health snapshots", async () => {
		let calls = 0
		const runtime = new DesktopRuntime(
			{ ...runtimeConfig(temporaryDirectory()), managed: true },
			(command) => {
				calls += 1
				return `/fake/${command}`
			},
		)
		await runtime.healthStatus()
		const firstCalls = calls
		await runtime.healthStatus()
		if (process.platform === "linux") {
			expect(firstCalls).toBeGreaterThan(0)
			expect(calls).toBe(firstCalls)
		} else {
			expect(calls).toBe(0)
		}
	})
})
