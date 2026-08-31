import { describe, expect, test } from "bun:test"
import { previewRequestPath } from "./preview-route-path"

describe("preview route path extraction", () => {
	test("extracts workspace preview asset paths without Hono wildcard params", () => {
		expect(
			previewRequestPath(
				"http://eigent.invalid/preview/abc/calculator.html?v=1",
				"/preview",
				"abc",
			),
		).toBe("calculator.html")
		expect(
			previewRequestPath(
				"http://eigent.invalid/preview/abc/pages/%ED%95%9C%EA%B8%80%20page.html",
				"/preview",
				"abc",
			),
		).toBe("pages/%ED%95%9C%EA%B8%80%20page.html")
	})

	test("returns an empty path for the token route root", () => {
		expect(
			previewRequestPath("http://eigent.invalid/local-preview/abc/", "/local-preview", "abc"),
		).toBe("")
	})
})
