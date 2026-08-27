/** Cross-platform terminal session: real PTY on Unix, pipe fallback on Bun/Windows. */
import * as pty from "node-pty"

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

function createPtyTerminal(options: CreateTerminalSessionOptions): TerminalSession {
	const shell = process.env.SHELL || "/bin/bash"
	const terminal = pty.spawn(shell, [], {
		name: "xterm-256color",
		cols: 120,
		rows: 32,
		cwd: options.cwd,
		env: process.env as Record<string, string>,
	})
	terminal.onData(options.onData)
	terminal.onExit(({ exitCode }) => options.onExit(exitCode))

	return {
		write(data) {
			terminal.write(data)
		},
		resize(cols, rows) {
			terminal.resize(Math.max(2, cols), Math.max(1, rows))
		},
		kill() {
			terminal.kill()
		},
	}
}

export function createTerminalSession(options: CreateTerminalSessionOptions): TerminalSession {
	return process.platform === "win32"
		? createWindowsPipeTerminal(options)
		: createPtyTerminal(options)
}
