/** Cross-platform terminal session: Node-backed real PTY on Unix, pipe fallback on Windows. */

export interface TerminalSession {
	write(data: string): void
	resize(cols: number, rows: number): void
	kill(): void
}

interface CreateTerminalSessionOptions {
	cwd: string
	onData: (data: string) => void
	onExit: (exitCode: number) => void
}

interface PtyWorkerMessage {
	type: "data" | "exit"
	data?: string
	exitCode?: number
}

const PTY_WORKER_SOURCE = String.raw`
const pty = require("node-pty")
const readline = require("node:readline")

const cwd = process.env.EIGENT_PTY_CWD
const shell = process.env.EIGENT_PTY_SHELL || process.env.SHELL || "/bin/bash"
let exiting = false

function send(message, callback) {
  process.stdout.write(JSON.stringify(message) + "\n", callback)
}

const terminal = pty.spawn(shell, [], {
  name: "xterm-256color",
  cols: 120,
  rows: 32,
  cwd,
  env: { ...process.env, TERM: "xterm-256color" },
})

terminal.onData((data) => send({ type: "data", data }))
terminal.onExit(({ exitCode }) => {
  if (exiting) return
  exiting = true
  send({ type: "exit", exitCode }, () => process.exit(0))
})

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on("line", (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.type === "input" && typeof message.data === "string") {
    terminal.write(message.data)
  } else if (message.type === "resize") {
    terminal.resize(Math.max(2, Number(message.cols) || 2), Math.max(1, Number(message.rows) || 1))
  } else if (message.type === "kill") {
    terminal.kill()
  }
})

process.on("SIGTERM", () => terminal.kill())
process.on("SIGINT", () => terminal.kill())
`

function normalizeWindowsInput(data: string): string {
	return data.replace(/\r(?!\n)/g, "\r\n")
}

async function pump(
	stream: ReadableStream<Uint8Array> | null,
	onData: (data: string) => void,
): Promise<void> {
	if (!stream) return
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		onData(decoder.decode(value, { stream: true }))
	}
	const tail = decoder.decode()
	if (tail) onData(tail)
}

async function pumpPtyWorker(
	stream: ReadableStream<Uint8Array> | null,
	onMessage: (message: PtyWorkerMessage) => void,
): Promise<void> {
	if (!stream) return
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let buffer = ""
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		buffer += decoder.decode(value, { stream: true })
		while (true) {
			const newline = buffer.indexOf("\n")
			if (newline < 0) break
			const line = buffer.slice(0, newline).trim()
			buffer = buffer.slice(newline + 1)
			if (!line) continue
			try {
				onMessage(JSON.parse(line) as PtyWorkerMessage)
			} catch {
				// Ignore malformed worker output; stderr is surfaced separately.
			}
		}
	}
	const tail = (buffer + decoder.decode()).trim()
	if (!tail) return
	try {
		onMessage(JSON.parse(tail) as PtyWorkerMessage)
	} catch {
		// Ignore an incomplete final line from an abruptly terminated worker.
	}
}

function createWindowsPipeTerminal(options: CreateTerminalSessionOptions): TerminalSession {
	const shell = process.env.COMSPEC || "cmd.exe"
	const child = Bun.spawn({
		cmd: [shell, "/Q"],
		cwd: options.cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, TERM: "xterm-256color" },
	})
	void pump(child.stdout as ReadableStream<Uint8Array>, options.onData)
	void pump(child.stderr as ReadableStream<Uint8Array>, options.onData)
	void child.exited.then(options.onExit)

	return {
		write(data) {
			const stdin = child.stdin
			if (!stdin || typeof stdin === "number") return
			stdin.write(normalizeWindowsInput(data))
		},
		resize() {
			// Pipe fallback has no terminal dimensions. Production Ubuntu uses a real PTY.
		},
		kill() {
			child.kill()
		},
	}
}

function createNodePtyTerminal(options: CreateTerminalSessionOptions): TerminalSession {
	const nodeBinary = process.env.EIGENT_NODE_BINARY || "node"
	const child = Bun.spawn({
		cmd: [nodeBinary, "-e", PTY_WORKER_SOURCE],
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			EIGENT_PTY_CWD: options.cwd,
			EIGENT_PTY_SHELL: process.env.SHELL || "/bin/bash",
		},
	})
	let exitNotified = false

	void pumpPtyWorker(child.stdout as ReadableStream<Uint8Array>, (message) => {
		if (message.type === "data" && typeof message.data === "string") {
			options.onData(message.data)
		} else if (message.type === "exit" && typeof message.exitCode === "number") {
			exitNotified = true
			options.onExit(message.exitCode)
		}
	})
	void pump(child.stderr as ReadableStream<Uint8Array>, (data) => {
		options.onData(`[pty-worker] ${data}`)
	})
	void child.exited.then((exitCode) => {
		if (!exitNotified) options.onExit(exitCode)
	})

	function send(message: Record<string, unknown>): void {
		const stdin = child.stdin
		if (!stdin || typeof stdin === "number") return
		stdin.write(`${JSON.stringify(message)}\n`)
	}

	return {
		write(data) {
			send({ type: "input", data })
		},
		resize(cols, rows) {
			send({ type: "resize", cols: Math.max(2, cols), rows: Math.max(1, rows) })
		},
		kill() {
			send({ type: "kill" })
			setTimeout(() => {
				if (!exitNotified) child.kill()
			}, 250)
		},
	}
}

export function createTerminalSession(options: CreateTerminalSessionOptions): TerminalSession {
	return process.platform === "win32"
		? createWindowsPipeTerminal(options)
		: createNodePtyTerminal(options)
}
