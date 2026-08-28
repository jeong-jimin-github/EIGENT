import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createTerminalSession } from "./terminal-session"

const linuxTest = process.platform === "linux" ? test : test.skip

linuxTest("node-pty handles Linux input, resize, output, and exit", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "eigent-pty-test-"))
	let output = ""
	let terminal: ReturnType<typeof createTerminalSession> | undefined
	try {
		const exited = new Promise<number>((resolve) => {
			terminal = createTerminalSession({
				cwd,
				onData: (data) => {
					output += data
				},
				onExit: resolve,
			})
		})

		const session = terminal
		if (!session) throw new Error("PTY session was not created")
		session.resize(90, 20)
		session.write("printf 'EIGENT_PTY_SMOKE\n'; stty size\r")

		const deadline = Date.now() + 5_000
		while (
			(!output.includes("EIGENT_PTY_SMOKE") || !/20\s+90/.test(output)) &&
			Date.now() < deadline
		) {
			await Bun.sleep(10)
		}
		expect(output).toContain("EIGENT_PTY_SMOKE")
		expect(output).toMatch(/20\s+90/)

		session.write("exit\r")
		const exitCode = await Promise.race([
			exited,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("PTY test timed out")), 5_000),
			),
		])
		expect(exitCode).toBe(0)
	} finally {
		terminal?.kill()
		await rm(cwd, { recursive: true, force: true })
	}
})
