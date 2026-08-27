/** Run the EIGENT web client and Bun backend together for local development. */

const commands = [
	[process.execPath, "run", "--cwd", "apps/server", "dev"],
	[process.execPath, "run", "--cwd", "apps/desktop", "dev:web"],
]

const children = commands.map((cmd) =>
	Bun.spawn({
		cmd,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	}),
)

const stop = () => {
	for (const child of children) child.kill()
}

process.on("SIGINT", stop)
process.on("SIGTERM", stop)

const exitCode = await Promise.race(children.map((child) => child.exited))
stop()
process.exit(exitCode)
