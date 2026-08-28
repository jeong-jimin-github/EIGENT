import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createTerminalSession } from "./terminal-session"

const linuxTest = process.platform === "linux" ? test : test.skip

function occurrences(value: string, marker: string): number {
	return value.split(marker).length - 1
}

linuxTest("node-pty handles Linux input, resize, output, and exit", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "eigent-pty-test-"))
	const sizeFile = path.join(cwd, ".pty-size")
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
		session.write("echo EIGENT_PTY_OUTPUT\r")

		let deadline = Date.now() + 1_500
		while (occurrences(output, "EIGENT_PTY_OUTPUT") < 2 && Date.now() < deadline) {
			await Bun.sleep(10)
		}
		// One occurrence is the terminal's command echo; the second is shell stdout.
		expect(occurrences(output, "EIGENT_PTY_OUTPUT")).toBeGreaterThanOrEqual(2)

		session.write("stty size > .pty-size\r")
		let size = ""
		deadline = Date.now() + 1_500
		while (!size && Date.now() < deadline) {
			try {
				size = (await readFile(sizeFile, "utf8")).trim()
			} catch {
				await Bun.sleep(10)
			}
		}
		expect(size).toMatch(/^20\s+90$/)

		session.write("exit\r")
		const exitCode = await Promise.race([
			exited,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("PTY test timed out")), 1_500),
			),
		])
		expect(exitCode).toBe(0)
	} finally {
		terminal?.kill()
		await rm(cwd, { recursive: true, force: true })
	}
})
