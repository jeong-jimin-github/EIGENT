/** Long-running command process manager for EIGENT. */
import { randomUUID } from "node:crypto"
import os from "node:os"
import type { ManagedProcessInfo } from "./process-types"
import { stateStore } from "./state"

export type { ManagedProcessInfo, ManagedProcessState } from "./process-types"

interface ManagedProcess extends ManagedProcessInfo {
	process: ReturnType<typeof Bun.spawn> | null
}

const processes = new Map<string, ManagedProcess>()
const MAX_OUTPUT_CHARS = 256 * 1024

stateStore.markRunningProcessesOrphaned()
for (const info of stateStore.listManagedProcesses()) {
	processes.set(info.id, { ...info, process: null })
}

function shellCommand(command: string): string[] {
	if (process.platform === "win32") {
		return ["powershell.exe", "-NoProfile", "-Command", command]
	}
	return [process.env.SHELL || "/bin/bash", "-lc", command]
}

function appendOutput(entry: ManagedProcess, text: string) {
	entry.output += text
	if (entry.output.length > MAX_OUTPUT_CHARS) {
		entry.output = entry.output.slice(entry.output.length - MAX_OUTPUT_CHARS)
	}
	stateStore.saveManagedProcess(snapshot(entry))
}

async function consumeStream(entry: ManagedProcess, stream: ReadableStream<Uint8Array> | null) {
	if (!stream) return
	const reader = stream.getReader()
	const decoder = new TextDecoder()
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		appendOutput(entry, decoder.decode(value, { stream: true }))
	}
	appendOutput(entry, decoder.decode())
}

function snapshot(entry: ManagedProcess): ManagedProcessInfo {
	const { process: _process, ...info } = entry
	return { ...info }
}

export function startManagedProcess(
	command: string,
	cwd: string,
	taskId?: string,
): ManagedProcessInfo {
	const id = randomUUID()
	const entry: ManagedProcess = {
		id,
		command,
		cwd,
		taskId,
		pid: null,
		state: "running",
		exitCode: null,
		startedAt: Date.now(),
		endedAt: null,
		output: "",
		process: null,
	}
	processes.set(id, entry)
	stateStore.saveManagedProcess(snapshot(entry))

	try {
		const child = Bun.spawn({
			cmd: shellCommand(command),
			cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
		})
		entry.process = child
		entry.pid = child.pid
		stateStore.saveManagedProcess(snapshot(entry))
		void consumeStream(entry, child.stdout as ReadableStream<Uint8Array>)
		void consumeStream(entry, child.stderr as ReadableStream<Uint8Array>)
		void child.exited
			.then((code) => {
				entry.exitCode = code
				entry.state = entry.state === "killed" ? "killed" : code === 0 ? "exited" : "failed"
				entry.endedAt = Date.now()
				entry.process = null
				stateStore.saveManagedProcess(snapshot(entry))
			})
			.catch((err) => {
				appendOutput(entry, `\n${err instanceof Error ? err.message : String(err)}\n`)
				entry.state = "failed"
				entry.endedAt = Date.now()
				entry.process = null
				stateStore.saveManagedProcess(snapshot(entry))
			})
	} catch (err) {
		entry.state = "failed"
		entry.endedAt = Date.now()
		appendOutput(entry, err instanceof Error ? err.message : String(err))
		stateStore.saveManagedProcess(snapshot(entry))
	}

	return snapshot(entry)
}

export function listManagedProcesses(): ManagedProcessInfo[] {
	return [...processes.values()].map(snapshot).toSorted((a, b) => b.startedAt - a.startedAt)
}

export function getManagedProcess(id: string): ManagedProcessInfo | null {
	const entry = processes.get(id)
	return entry ? snapshot(entry) : null
}

export function writeManagedProcess(id: string, input: string): boolean {
	const entry = processes.get(id)
	if (!entry?.process || entry.state !== "running") return false
	const stdin = entry.process.stdin
	if (!stdin || typeof stdin === "number") return false
	stdin.write(input)
	return true
}

export function killManagedProcess(id: string): boolean {
	const entry = processes.get(id)
	if (!entry?.process || entry.state !== "running") return false
	entry.state = "killed"
	stateStore.saveManagedProcess(snapshot(entry))
	entry.process.kill()
	return true
}

export function clearFinishedProcesses(): number {
	let removed = 0
	for (const [id, entry] of processes) {
		if (entry.state !== "running") {
			processes.delete(id)
			stateStore.deleteManagedProcess(id)
			removed += 1
		}
	}
	return removed
}

export const DEFAULT_SHELL =
	process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash"
export const HOSTNAME = os.hostname()
