/** Persistent Linux graphical desktop runtime and Computer action surface. */

import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

export type DesktopRuntimeState = "idle" | "starting" | "ready" | "error" | "unsupported"
export type DesktopControlOwner = "agent" | "user"

export interface DesktopRuntimeConfig {
	enabled: boolean
	managed: boolean
	display: string
	geometry: string
	vncHost: string
	vncPort: number
	sharedDir: string
	startupTimeoutMs: number
}

export interface DesktopRuntimeStatus extends DesktopRuntimeConfig {
	state: DesktopRuntimeState
	supported: boolean
	ready: boolean
	controlOwner: DesktopControlOwner
	controlEpoch: number
	lastError?: string
	xReady: boolean
	vncReady: boolean
	pids: Partial<Record<"xvfb" | "openbox" | "x11vnc", number>>
	missingCommands: string[]
}

export type ComputerAction =
	| { action: "screenshot" }
	| { action: "mouse_move"; x: number; y: number }
	| { action: "mouse_click"; button?: 1 | 2 | 3; x?: number; y?: number; count?: number }
	| { action: "key"; keys: string[] }
	| { action: "type"; text: string; intervalMs?: number }
	| { action: "windows" }
	| { action: "activate_window"; id: string }
	| { action: "launch"; command: string; args?: string[] }
	| { action: "clipboard_get" }
	| { action: "clipboard_set"; text: string }

const REQUIRED_COMMANDS = [
	"Xvfb",
	"openbox",
	"x11vnc",
	"xdotool",
	"scrot",
	"xclip",
	"xdpyinfo",
] as const
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function envBool(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase()
	return raw ? ["1", "true", "yes", "on"].includes(raw) : fallback
}

function envNumber(name: string, fallback: number): number {
	const value = Number(process.env[name])
	return Number.isFinite(value) && value > 0 ? value : fallback
}

function defaultDataDir(): string {
	if (process.env.EIGENT_DATA_DIR) return path.resolve(process.env.EIGENT_DATA_DIR)
	const root =
		process.env.XDG_DATA_HOME ??
		(process.platform === "win32"
			? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"))
			: path.join(os.homedir(), ".local", "share"))
	return path.join(root, "eigent")
}

export function loadDesktopRuntimeConfig(): DesktopRuntimeConfig {
	const enabledDefault = process.platform === "linux"
	return {
		enabled: envBool("EIGENT_DESKTOP_ENABLED", enabledDefault),
		managed: envBool("EIGENT_DESKTOP_MANAGED", true),
		display: process.env.EIGENT_DESKTOP_DISPLAY?.trim() || ":99",
		geometry: process.env.EIGENT_DESKTOP_GEOMETRY?.trim() || "1440x900x24",
		vncHost: process.env.EIGENT_DESKTOP_VNC_HOST?.trim() || "127.0.0.1",
		vncPort: envNumber("EIGENT_DESKTOP_VNC_PORT", 5900),
		sharedDir: path.resolve(
			process.env.EIGENT_DESKTOP_SHARED_DIR ?? path.join(defaultDataDir(), "desktop", "shared"),
		),
		startupTimeoutMs: envNumber("EIGENT_DESKTOP_STARTUP_TIMEOUT_MS", 15_000),
	}
}

export function commandPath(command: string): string | undefined {
	const locator = process.platform === "win32" ? "where" : "which"
	const result = spawnSync(locator, [command], { encoding: "utf8", windowsHide: true })
	if (result.status !== 0) return undefined
	return result.stdout
		.split(/\r?\n/)
		.map((value) => value.trim())
		.find(Boolean)
}

function tcpAvailable(host: string, port: number, timeoutMs = 500): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host, port })
		let settled = false
		const finish = (value: boolean) => {
			if (settled) return
			settled = true
			socket.destroy()
			resolve(value)
		}
		socket.setTimeout(timeoutMs)
		socket.once("connect", () => finish(true))
		socket.once("timeout", () => finish(false))
		socket.once("error", () => finish(false))
	})
}

export class DesktopRuntime {
	private state: DesktopRuntimeState = "idle"
	private readonly pidDir: string
	private ensurePromise?: Promise<void>
	private lastError?: string
	private controlOwner: DesktopControlOwner = "agent"
	private controlEpoch = 0
	private readonly children = new Map<"xvfb" | "openbox" | "x11vnc", ChildProcess>()

	constructor(private readonly config = loadDesktopRuntimeConfig()) {
		this.pidDir = path.join(config.sharedDir, ".runtime")
		if (!existsSync(config.sharedDir)) mkdirSync(config.sharedDir, { recursive: true })
		if (!existsSync(this.pidDir)) mkdirSync(this.pidDir, { recursive: true })
		if (!config.enabled || process.platform !== "linux") this.state = "unsupported"
	}

	getConfig(): DesktopRuntimeConfig {
		return { ...this.config }
	}

	getControlOwner(): DesktopControlOwner {
		return this.controlOwner
	}

	takeControl(): { controlOwner: DesktopControlOwner; controlEpoch: number } {
		this.controlOwner = "user"
		this.controlEpoch += 1
		return { controlOwner: this.controlOwner, controlEpoch: this.controlEpoch }
	}

	returnControl(): { controlOwner: DesktopControlOwner; controlEpoch: number } {
		this.controlOwner = "agent"
		this.controlEpoch += 1
		return { controlOwner: this.controlOwner, controlEpoch: this.controlEpoch }
	}

	private displayEnv(): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			DISPLAY: this.config.display,
			XDG_SESSION_TYPE: "x11",
			GDK_BACKEND: "x11",
			QT_QPA_PLATFORM: "xcb",
		}
		delete env.WAYLAND_DISPLAY
		return env
	}

	private xAvailable(): boolean {
		if (process.platform !== "linux") return false
		const xdpyinfo = commandPath("xdpyinfo")
		if (!xdpyinfo) return false
		const result = spawnSync(xdpyinfo, ["-display", this.config.display], {
			stdio: "ignore",
			env: this.displayEnv(),
		})
		return result.status === 0
	}

	private missingCommands(): string[] {
		if (process.platform !== "linux") return [...REQUIRED_COMMANDS]
		return REQUIRED_COMMANDS.filter((command) => !commandPath(command))
	}

	private pidFile(kind: "xvfb" | "openbox" | "x11vnc"): string {
		return path.join(this.pidDir, `${kind}.pid`)
	}

	private rememberPid(kind: "xvfb" | "openbox" | "x11vnc", pid: number): void {
		writeFileSync(this.pidFile(kind), String(pid))
	}

	private forgetPid(kind: "xvfb" | "openbox" | "x11vnc"): void {
		const filename = this.pidFile(kind)
		if (existsSync(filename)) unlinkSync(filename)
	}

	private rememberedPid(kind: "xvfb" | "openbox" | "x11vnc"): number | undefined {
		const filename = this.pidFile(kind)
		if (!existsSync(filename) || process.platform !== "linux") return undefined
		const pid = Number.parseInt(readFileSync(filename, "utf8").trim(), 10)
		if (!Number.isInteger(pid) || pid <= 0) {
			this.forgetPid(kind)
			return undefined
		}

		const expected = kind === "xvfb" ? "Xvfb" : kind
		try {
			const command = readFileSync(`/proc/${pid}/comm`, "utf8").trim()
			if (command !== expected) {
				this.forgetPid(kind)
				return undefined
			}
			return pid
		} catch {
			this.forgetPid(kind)
			return undefined
		}
	}

	private launchDetached(
		kind: "xvfb" | "openbox" | "x11vnc",
		command: string,
		args: string[],
	): void {
		const executable = commandPath(command)
		if (!executable) throw new Error(`${command} is required for the managed desktop runtime`)
		const child = spawn(executable, args, {
			detached: true,
			stdio: "ignore",
			env: this.displayEnv(),
		})
		child.unref()
		this.children.set(kind, child)
		if (child.pid) this.rememberPid(kind, child.pid)
	}

	private async waitUntil(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
		const deadline = Date.now() + this.config.startupTimeoutMs
		while (Date.now() < deadline) {
			if (await check()) return
			await delay(200)
		}
		throw new Error(`${label} did not become ready within ${this.config.startupTimeoutMs}ms`)
	}

	async ensureReady(): Promise<void> {
		if (!this.config.enabled) throw new Error("Desktop runtime is disabled")
		if (process.platform !== "linux")
			throw new Error("Managed desktop runtime is supported on Linux only")
		if (this.xAvailable() && (await tcpAvailable(this.config.vncHost, this.config.vncPort))) {
			this.state = "ready"
			return
		}
		if (this.ensurePromise) return this.ensurePromise

		this.ensurePromise = (async () => {
			this.state = "starting"
			this.lastError = undefined
			try {
				if (!this.config.managed) {
					if (!this.xAvailable())
						throw new Error(`No X display is available at ${this.config.display}`)
					if (!(await tcpAvailable(this.config.vncHost, this.config.vncPort))) {
						throw new Error(
							`No VNC server is available at ${this.config.vncHost}:${this.config.vncPort}`,
						)
					}
					this.state = "ready"
					return
				}

				const missing = this.missingCommands()
				if (missing.length > 0) {
					throw new Error(`Missing desktop dependencies: ${missing.join(", ")}`)
				}

				if (!this.xAvailable()) {
					this.launchDetached("xvfb", "Xvfb", [
						this.config.display,
						"-screen",
						"0",
						this.config.geometry,
						"-nolisten",
						"tcp",
						"-ac",
					])
					await this.waitUntil(() => this.xAvailable(), `X display ${this.config.display}`)
				}

				if (!this.children.get("openbox")) this.launchDetached("openbox", "openbox", [])
				if (!(await tcpAvailable(this.config.vncHost, this.config.vncPort))) {
					this.launchDetached("x11vnc", "x11vnc", [
						"-display",
						this.config.display,
						"-rfbport",
						String(this.config.vncPort),
						"-localhost",
						"-forever",
						"-shared",
						"-nopw",
						"-noxdamage",
					])
					await this.waitUntil(
						() => tcpAvailable(this.config.vncHost, this.config.vncPort),
						`VNC server ${this.config.vncHost}:${this.config.vncPort}`,
					)
				}
				this.state = "ready"
			} catch (error) {
				this.state = "error"
				this.lastError = error instanceof Error ? error.message : String(error)
				throw error
			} finally {
				this.ensurePromise = undefined
			}
		})()
		return this.ensurePromise
	}

	async restart(): Promise<void> {
		for (const kind of ["x11vnc", "openbox", "xvfb"] as const) {
			const child = this.children.get(kind)
			const remembered = this.rememberedPid(kind)
			if (child) {
				try {
					child.kill("SIGTERM")
				} catch {
					/* process may already be gone */
				}
			}
			if (remembered && remembered !== child?.pid) {
				try {
					process.kill(remembered, "SIGTERM")
				} catch {
					/* process may already be gone */
				}
			}
			this.forgetPid(kind)
		}
		this.children.clear()
		this.state = "idle"
		await delay(500)
		await this.ensureReady()
	}

	async status(): Promise<DesktopRuntimeStatus> {
		const supported = this.config.enabled && process.platform === "linux"
		const xReady = supported ? this.xAvailable() : false
		const vncReady = supported
			? await tcpAvailable(this.config.vncHost, this.config.vncPort)
			: false
		const ready = supported && xReady && vncReady
		if (ready && this.state !== "starting") this.state = "ready"
		if (!supported) this.state = "unsupported"
		return {
			...this.config,
			state: this.state,
			supported,
			ready,
			controlOwner: this.controlOwner,
			controlEpoch: this.controlEpoch,
			lastError: this.lastError,
			xReady,
			vncReady,
			pids: Object.fromEntries(
				(["xvfb", "openbox", "x11vnc"] as const)
					.map((kind) => [kind, this.children.get(kind)?.pid ?? this.rememberedPid(kind)] as const)
					.filter((entry): entry is readonly [(typeof entry)[0], number] => entry[1] !== undefined),
			),
			missingCommands: supported ? this.missingCommands() : [...REQUIRED_COMMANDS],
		}
	}

	private assertAgentControl(): void {
		if (this.controlOwner !== "agent") {
			throw new Error("Computer input is locked while the user has Take Control")
		}
	}

	private runXdotool(args: string[]): string {
		const executable = commandPath("xdotool")
		if (!executable) throw new Error("xdotool is required for Computer actions")
		const result = spawnSync(executable, args, {
			encoding: "utf8",
			env: this.displayEnv(),
			maxBuffer: 4 * 1024 * 1024,
		})
		if (result.status !== 0) throw new Error(result.stderr?.trim() || `xdotool ${args[0]} failed`)
		return result.stdout.trim()
	}

	async action(input: ComputerAction): Promise<unknown> {
		await this.ensureReady()
		if (input.action === "screenshot") return this.screenshot()
		if (input.action === "clipboard_get") return { text: this.readClipboard() }
		this.assertAgentControl()

		switch (input.action) {
			case "mouse_move":
				this.runXdotool([
					"mousemove",
					"--sync",
					String(Math.round(input.x)),
					String(Math.round(input.y)),
				])
				return { ok: true }
			case "mouse_click": {
				if (input.x !== undefined && input.y !== undefined) {
					this.runXdotool([
						"mousemove",
						"--sync",
						String(Math.round(input.x)),
						String(Math.round(input.y)),
					])
				}
				const count = Math.max(1, Math.min(3, Math.round(input.count ?? 1)))
				for (let index = 0; index < count; index += 1) {
					this.runXdotool(["click", String(input.button ?? 1)])
				}
				return { ok: true }
			}
			case "key":
				this.runXdotool(["key", "--clearmodifiers", input.keys.join("+")])
				return { ok: true }
			case "type":
				this.runXdotool([
					"type",
					"--clearmodifiers",
					"--delay",
					String(Math.max(0, Math.min(1000, Math.round(input.intervalMs ?? 10)))),
					"--",
					input.text,
				])
				return { ok: true }
			case "windows": {
				let ids: string[] = []
				try {
					ids = this.runXdotool(["search", "--onlyvisible", "--name", ".*"])
						.split(/\r?\n/)
						.filter(Boolean)
				} catch {
					return { windows: [] }
				}
				return {
					windows: ids.map((id) => {
						let title = ""
						try {
							title = this.runXdotool(["getwindowname", id])
						} catch {
							/* window may close while listing */
						}
						return { id, title }
					}),
				}
			}
			case "activate_window":
				this.runXdotool(["windowactivate", "--sync", input.id])
				return { ok: true }
			case "launch": {
				const executable = commandPath(input.command)
				if (!executable) throw new Error(`GUI executable not found: ${input.command}`)
				const child = spawn(executable, input.args ?? [], {
					detached: true,
					stdio: "ignore",
					env: this.displayEnv(),
				})
				child.unref()
				return { ok: true, pid: child.pid }
			}
			case "clipboard_set":
				this.writeClipboard(input.text)
				return { ok: true }
		}
	}

	private screenshot(): { base64: string; mimeType: "image/png" } {
		const executable = commandPath("scrot")
		if (!executable) throw new Error("scrot is required for desktop screenshots")
		const filename = path.join(os.tmpdir(), `eigent-desktop-${process.pid}-${Date.now()}.png`)
		try {
			const result = spawnSync(executable, ["-o", filename], {
				stdio: "pipe",
				env: this.displayEnv(),
			})
			if (result.status !== 0) throw new Error(result.stderr?.toString().trim() || "scrot failed")
			return { base64: readFileSync(filename).toString("base64"), mimeType: "image/png" }
		} finally {
			if (existsSync(filename)) unlinkSync(filename)
		}
	}

	private readClipboard(): string {
		const executable = commandPath("xclip")
		if (!executable) throw new Error("xclip is required for clipboard access")
		const result = spawnSync(executable, ["-selection", "clipboard", "-o"], {
			encoding: "utf8",
			env: this.displayEnv(),
		})
		if (result.status !== 0) return ""
		return result.stdout
	}

	private writeClipboard(text: string): void {
		const executable = commandPath("xclip")
		if (!executable) throw new Error("xclip is required for clipboard access")
		const result = spawnSync(executable, ["-selection", "clipboard", "-i"], {
			input: text,
			encoding: "utf8",
			env: this.displayEnv(),
			stdio: ["pipe", "ignore", "ignore"],
		})
		if (result.status !== 0) throw new Error(result.stderr?.trim() || "xclip failed")
	}

	storeSharedFile(filename: string, data: Uint8Array): string {
		const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._ -]/g, "_") || "upload.bin"
		const target = path.join(this.config.sharedDir, safeName)
		writeFileSync(target, data)
		return target
	}
}

export const desktopRuntime = new DesktopRuntime()
