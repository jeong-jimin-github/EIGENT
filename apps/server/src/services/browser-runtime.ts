import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export type BrowserRuntimeState = "idle" | "starting" | "ready" | "error"
export interface BrowserRuntimeConfig {
	executablePath?: string
	profileDir: string
	downloadDir: string
	uploadDir: string
	debugPort: number
	workerPort: number
	headless: boolean
	startupTimeoutMs: number
}
export interface BrowserTabInfo {
	id: string
	url: string
	title: string
	loading?: boolean
}
export interface BrowserDialogInfo {
	type: string
	message: string
	defaultValue?: string
}
export interface BrowserActivityInfo {
	sequence: number
	kind: string
	phase: string
	pageId: string | null
	at: number
	action?: string
	url?: string
	filename?: string
	error?: string
}
export interface BrowserTransferInfo {
	kind: "upload" | "download"
	state: string
	pageId?: string
	at: number
	filename?: string
	path?: string
	files?: string[]
}
export interface BrowserLiveSnapshot {
	capturedAt: number
	pageId: string
	url: string
	title: string
	loading: boolean
	viewport: { width: number; height: number; deviceScaleFactor: number } | null
	mimeType: "image/jpeg"
	imageBase64?: string
	tabs: BrowserTabInfo[]
	activity?: BrowserActivityInfo | null
	dialog?: BrowserDialogInfo | null
	transfer?: BrowserTransferInfo | null
}
export interface BrowserRuntimeStatus extends BrowserRuntimeConfig {
	state: BrowserRuntimeState
	connected: boolean
	cdpUrl: string
	workerUrl: string
	spawnedPid?: number
	workerPid?: number
	lastError?: string
	tabs: BrowserTabInfo[]
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
function envBool(name: string, fallback: boolean): boolean {
	const raw = process.env[name]?.trim().toLowerCase()
	return raw ? ["1", "true", "yes", "on"].includes(raw) : fallback
}
function envNumber(name: string, fallback: number): number {
	const value = Number(process.env[name])
	return Number.isFinite(value) && value > 0 ? value : fallback
}
export function loadBrowserRuntimeConfig(): BrowserRuntimeConfig {
	const dataDir = defaultDataDir()
	const debugPort = envNumber("EIGENT_BROWSER_DEBUG_PORT", 9223)
	const desktopEnabled = envBool("EIGENT_DESKTOP_ENABLED", process.platform === "linux")
	const defaultHeadless =
		process.platform === "linux" &&
		!process.env.DISPLAY &&
		!process.env.WAYLAND_DISPLAY &&
		!desktopEnabled
	return {
		executablePath: process.env.EIGENT_BROWSER_EXECUTABLE?.trim() || undefined,
		profileDir: path.resolve(
			process.env.EIGENT_BROWSER_PROFILE_DIR ?? path.join(dataDir, "browser", "profile"),
		),
		downloadDir: path.resolve(
			process.env.EIGENT_BROWSER_DOWNLOAD_DIR ?? path.join(dataDir, "browser", "downloads"),
		),
		uploadDir: path.resolve(
			process.env.EIGENT_BROWSER_UPLOAD_DIR ?? path.join(dataDir, "browser", "uploads"),
		),
		debugPort,
		workerPort: envNumber("EIGENT_BROWSER_WORKER_PORT", debugPort + 1),
		headless: envBool("EIGENT_BROWSER_HEADLESS", defaultHeadless),
		startupTimeoutMs: envNumber("EIGENT_BROWSER_STARTUP_TIMEOUT_MS", 15_000),
	}
}
function commandPath(command: string): string | undefined {
	const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
		encoding: "utf8",
		windowsHide: true,
	})
	if (result.status !== 0) return undefined
	return result.stdout
		.split(/\r?\n/)
		.map((value) => value.trim())
		.find(Boolean)
}
export function discoverBrowserExecutable(explicit?: string): string | undefined {
	if (explicit) {
		const resolved = path.resolve(explicit)
		return existsSync(resolved) ? resolved : undefined
	}
	const candidates: string[] = []
	if (process.platform === "win32") {
		for (const base of [
			process.env.PROGRAMFILES,
			process.env["PROGRAMFILES(X86)"],
			process.env.LOCALAPPDATA,
		]) {
			if (!base) continue
			candidates.push(path.join(base, "Google", "Chrome", "Application", "chrome.exe"))
			candidates.push(path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"))
		}
	} else if (process.platform === "darwin") {
		candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
		candidates.push("/Applications/Chromium.app/Contents/MacOS/Chromium")
		candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
	} else {
		for (const name of [
			"google-chrome",
			"google-chrome-stable",
			"chromium",
			"chromium-browser",
			"microsoft-edge",
		]) {
			const found = commandPath(name)
			if (found) candidates.push(found)
		}
	}
	return candidates.find((candidate) => existsSync(candidate))
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class BrowserRuntime {
	private state: BrowserRuntimeState = "idle"
	private ensurePromise?: Promise<void>
	private spawnedPid?: number
	private workerPid?: number
	private lastError?: string

	constructor(private readonly config = loadBrowserRuntimeConfig()) {
		for (const dir of [config.profileDir, config.downloadDir, config.uploadDir]) {
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
		}
	}
	getConfig(): BrowserRuntimeConfig {
		return { ...this.config }
	}
	private cdpUrl(): string {
		return `http://127.0.0.1:${this.config.debugPort}`
	}
	private workerUrl(): string {
		return `http://127.0.0.1:${this.config.workerPort}`
	}
	private async cdpAvailable(): Promise<boolean> {
		try {
			return (
				await fetch(`${this.cdpUrl()}/json/version`, { signal: AbortSignal.timeout(10_000) })
			).ok
		} catch {
			return false
		}
	}
	private async workerAvailable(): Promise<boolean> {
		try {
			const response = await fetch(`${this.workerUrl()}/health`, {
				signal: AbortSignal.timeout(10_000),
			})
			if (!response.ok) return false
			const body = (await response.json()) as { service?: string }
			return body.service === "eigent-browser-worker"
		} catch {
			return false
		}
	}
	private launchBrowser(executablePath: string): void {
		const args = [
			`--remote-debugging-port=${this.config.debugPort}`,
			"--remote-debugging-address=127.0.0.1",
			"--remote-allow-origins=*",
			`--user-data-dir=${this.config.profileDir}`,
			"--profile-directory=Default",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-default-apps",
			"--disable-popup-blocking",
			"--restore-last-session",
		]
		if (process.env.EIGENT_BROWSER_LOW_MEMORY === "true") {
			args.push(
				"--renderer-process-limit=2",
				"--disable-background-networking",
				"--disable-component-update",
				"--disable-sync",
				"--no-service-autorun",
			)
		}
		if (this.config.headless) args.push("--headless=new", "--disable-gpu")
		if (
			process.platform === "linux" &&
			typeof process.getuid === "function" &&
			process.getuid() === 0
		)
			args.push("--no-sandbox")
		const child = spawn(executablePath, args, {
			env: this.config.headless
				? process.env
				: {
						...process.env,
						DISPLAY:
							process.env.EIGENT_BROWSER_DISPLAY ??
							process.env.EIGENT_DESKTOP_DISPLAY ??
							process.env.DISPLAY ??
							":99",
						WAYLAND_DISPLAY: undefined,
						XDG_SESSION_TYPE: "x11",
					},
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		})
		child.unref()
		this.spawnedPid = child.pid
	}

	private workerPath(): string {
		const source = path.resolve(import.meta.dir, "../browser-worker.mjs")
		if (existsSync(source)) return source
		const bundled = path.resolve(import.meta.dir, "browser-worker.mjs")
		if (existsSync(bundled)) return bundled
		throw new Error("EIGENT browser Playwright worker is missing")
	}

	private launchWorker(): void {
		const nodeExecutable = commandPath("node")
		if (!nodeExecutable)
			throw new Error("Node.js is required for the EIGENT Playwright browser worker")
		const child = spawn(nodeExecutable, [this.workerPath()], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			env: {
				...process.env,
				EIGENT_BROWSER_CDP_URL: this.cdpUrl(),
				EIGENT_BROWSER_WORKER_PORT: String(this.config.workerPort),
				EIGENT_BROWSER_DOWNLOAD_DIR: this.config.downloadDir,
				EIGENT_BROWSER_UPLOAD_DIR: this.config.uploadDir,
			},
		})
		child.unref()
		this.workerPid = child.pid
	}

	private async waitUntil(check: () => Promise<boolean>, label: string): Promise<void> {
		const deadline = Date.now() + this.config.startupTimeoutMs
		while (Date.now() < deadline) {
			if (await check()) return
			await delay(200)
		}
		throw new Error(`${label} did not become ready within ${this.config.startupTimeoutMs}ms`)
	}

	async ensureReady(): Promise<void> {
		if ((await this.cdpAvailable()) && (await this.workerAvailable())) {
			this.state = "ready"
			return
		}
		if (this.ensurePromise) return this.ensurePromise
		this.ensurePromise = (async () => {
			this.state = "starting"
			this.lastError = undefined
			try {
				if (!(await this.cdpAvailable())) {
					const executable = discoverBrowserExecutable(this.config.executablePath)
					if (!executable)
						throw new Error(
							"No Chrome/Chromium/Edge executable found. Set EIGENT_BROWSER_EXECUTABLE.",
						)
					this.launchBrowser(executable)
					await this.waitUntil(() => this.cdpAvailable(), `Browser CDP at ${this.cdpUrl()}`)
				}
				if (!(await this.workerAvailable())) {
					this.launchWorker()
					await this.waitUntil(
						() => this.workerAvailable(),
						`Playwright worker at ${this.workerUrl()}`,
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

	async action(input: unknown): Promise<unknown> {
		await this.ensureReady()
		const response = await fetch(`${this.workerUrl()}/action`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
			signal: AbortSignal.timeout(60_000),
		})
		const body = (await response.json()) as { result?: unknown; error?: string }
		if (!response.ok || body.error)
			throw new Error(body.error ?? `Browser worker returned HTTP ${response.status}`)
		return body.result
	}

	async liveSnapshot(
		options: { pageId?: string; quality?: number } = {},
	): Promise<BrowserLiveSnapshot> {
		await this.ensureReady()
		const response = await fetch(`${this.workerUrl()}/live`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(options),
			signal: AbortSignal.timeout(10_000),
		})
		const body = (await response.json()) as { snapshot?: BrowserLiveSnapshot; error?: string }
		if (!response.ok || !body.snapshot) {
			throw new Error(body.error ?? `Browser worker returned HTTP ${response.status}`)
		}
		return body.snapshot
	}

	async status(): Promise<BrowserRuntimeStatus> {
		const [cdp, worker] = await Promise.all([this.cdpAvailable(), this.workerAvailable()])
		let tabs: BrowserTabInfo[] = []
		if (worker) {
			try {
				const response = await fetch(`${this.workerUrl()}/status`, {
					signal: AbortSignal.timeout(1000),
				})
				const body = (await response.json()) as { tabs?: BrowserTabInfo[] }
				tabs = body.tabs ?? []
			} catch {
				/* status remains usable */
			}
		}
		const connected = cdp && worker
		if (connected && this.state !== "starting") this.state = "ready"
		return {
			...this.config,
			executablePath: discoverBrowserExecutable(this.config.executablePath),
			state: this.state,
			connected,
			cdpUrl: this.cdpUrl(),
			workerUrl: this.workerUrl(),
			spawnedPid: this.spawnedPid,
			workerPid: this.workerPid,
			lastError: this.lastError,
			tabs,
		}
	}

	resolveDownloadPath(filename: string): string {
		return path.join(this.config.downloadDir, path.basename(filename))
	}
}

export const browserRuntime = new BrowserRuntime()
