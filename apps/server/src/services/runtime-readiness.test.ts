import { describe, expect, test } from "bun:test"
import type { BrowserRuntimeStatus } from "./browser-runtime"
import type { DesktopRuntimeStatus } from "./desktop-runtime"
import {
	browserRuntimeReadyForRequests,
	desktopRuntimeReadyForRequests,
	readinessSummary,
} from "./runtime-readiness"

function browser(overrides: Partial<BrowserRuntimeStatus> = {}): BrowserRuntimeStatus {
	return {
		profileDir: "/tmp/profile",
		downloadDir: "/tmp/downloads",
		uploadDir: "/tmp/uploads",
		debugPort: 9223,
		workerPort: 9224,
		headless: true,
		startupTimeoutMs: 1000,
		idleTimeoutMs: 60_000,
		state: "idle",
		connected: false,
		cdpUrl: "http://127.0.0.1:9223",
		workerUrl: "http://127.0.0.1:9224",
		executablePath: "/usr/bin/chrome",
		tabs: [],
		...overrides,
	}
}

function desktop(overrides: Partial<DesktopRuntimeStatus> = {}): DesktopRuntimeStatus {
	return {
		enabled: true,
		managed: true,
		display: ":99",
		geometry: "1280x720x24",
		vncHost: "127.0.0.1",
		vncPort: 5900,
		sharedDir: "/tmp/shared",
		startupTimeoutMs: 1000,
		idleTimeoutMs: 60_000,
		state: "idle",
		supported: true,
		ready: false,
		controlOwner: "agent",
		controlEpoch: 0,
		xReady: false,
		vncReady: false,
		pids: {},
		missingCommands: [],
		...overrides,
	}
}

describe("runtime readiness", () => {
	test("treats an installed idle browser as healthy without starting it", () => {
		expect(browserRuntimeReadyForRequests(browser())).toBeTrue()
		expect(browserRuntimeReadyForRequests(browser({ executablePath: undefined }))).toBeFalse()
		expect(browserRuntimeReadyForRequests(browser({ state: "error" }))).toBeFalse()
	})

	test("treats a managed idle desktop as healthy when dependencies are installed", () => {
		expect(desktopRuntimeReadyForRequests(desktop())).toBeTrue()
		expect(desktopRuntimeReadyForRequests(desktop({ missingCommands: ["Xvfb"] }))).toBeFalse()
		expect(desktopRuntimeReadyForRequests(desktop({ managed: false }))).toBeFalse()
		expect(desktopRuntimeReadyForRequests(desktop({ state: "error" }))).toBeFalse()
	})

	test("accepts connected runtimes and disabled desktops", () => {
		expect(browserRuntimeReadyForRequests(browser({ state: "ready", connected: true }))).toBeTrue()
		expect(desktopRuntimeReadyForRequests(desktop({ state: "ready", ready: true }))).toBeTrue()
		expect(
			desktopRuntimeReadyForRequests(desktop({ enabled: false, state: "unsupported" })),
		).toBeTrue()
	})
})

describe("readiness summary", () => {
	test("returns 200 only when every component is ready", () => {
		expect(readinessSummary({ browser: { ok: true }, desktop: { ok: true } })).toEqual({
			status: "ok",
			httpStatus: 200,
		})
	})

	test("returns degraded 503 when any component is not ready", () => {
		expect(readinessSummary({ browser: { ok: false }, desktop: { ok: true } })).toEqual({
			status: "degraded",
			httpStatus: 503,
		})
	})
})
