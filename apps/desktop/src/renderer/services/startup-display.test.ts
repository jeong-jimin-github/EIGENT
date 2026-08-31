import { describe, expect, test } from "bun:test"
import { STARTUP_OVERLAY_BASE_CLASS, isStartupContentVisible } from "./startup-display"

describe("startup display", () => {
	test("keeps the app shell hidden through every loading phase", () => {
		for (const phase of ["idle", "starting-server", "connecting", "loading-projects", "loading-sessions"] as const) {
			expect(isStartupContentVisible(phase)).toBe(false)
		}
		expect(isStartupContentVisible("ready")).toBe(true)
		expect(isStartupContentVisible("error")).toBe(true)
	})

	test("uses an opaque startup surface so menus cannot bleed through", () => {
		expect(STARTUP_OVERLAY_BASE_CLASS.split(/\s+/)).toContain("bg-background")
	})
})
