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
		session.write("printf 'EIGENT_PTY_SMOKE\n'; stty size; exit\r")
		const exitCode = await Promise.race([
			exited,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("PTY test timed out")), 4_000),
			),
		])
		// node-pty may report exit before Bun has delivered the final onData chunk.
		await Bun.sleep(100)
		expect(exitCode).toBe(0)
		expect(output).toContain("EIGENT_PTY_SMOKE")
		expect(output).toMatch(/20\s+90/)
	} finally {
		terminal?.kill()
		await rm(cwd, { recursive: true, force: true })
	}
})
