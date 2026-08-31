import { describe, expect, test } from "bun:test"
import {
	createLoopbackPreviewSession,
	isLoopbackPreviewUrl,
	proxyLoopbackPreviewRequest,
} from "./loopback-preview"

describe("loopback device preview", () => {
	test("accepts only HTTP loopback dev servers and excludes the EIGENT server port", () => {
		const previousPort = process.env.PORT
		process.env.PORT = "3100"
		try {
			expect(isLoopbackPreviewUrl("http://127.0.0.1:5173/")).toBe(true)
			expect(isLoopbackPreviewUrl("http://localhost:3000/app")).toBe(true)
			expect(isLoopbackPreviewUrl("http://127.0.0.1:3100/")).toBe(false)
			expect(isLoopbackPreviewUrl("https://127.0.0.1:5173/")).toBe(false)
			expect(isLoopbackPreviewUrl("http://example.com:5173/")).toBe(false)
		} finally {
			if (previousPort === undefined) delete process.env.PORT
			else process.env.PORT = previousPort
		}
	})

	test("proxies a dev page and rewrites Vite-style root imports into the token namespace", async () => {
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url)
				if (url.pathname === "/src/main.tsx") {
					return new Response('import App from "/src/App.tsx"; import "/src/style.css";', {
						headers: { "content-type": "application/javascript" },
					})
				}
				return new Response('<script type="module" src="/src/main.tsx"></script>', {
					headers: { "content-type": "text/html; charset=utf-8" },
				})
			},
		})
		try {
			const session = createLoopbackPreviewSession(`http://127.0.0.1:${server.port}/`)
			const html = await proxyLoopbackPreviewRequest(
				session.token,
				"",
				new Request(`http://eigent.invalid/local-preview/${session.token}/`),
			)
			expect(await html.text()).toContain(`/local-preview/${session.token}/src/main.tsx`)

			const js = await proxyLoopbackPreviewRequest(
				session.token,
				"src/main.tsx",
				new Request(`http://eigent.invalid/local-preview/${session.token}/src/main.tsx`),
			)
			const source = await js.text()
			expect(source).toContain(`from "/local-preview/${session.token}/src/App.tsx"`)
			expect(source).toContain(`import "/local-preview/${session.token}/src/style.css"`)
		} finally {
			server.stop(true)
		}
	})
})
