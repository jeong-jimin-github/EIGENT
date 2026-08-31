import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

const BACKUP_FORMAT = "eigent-server-backup"
const BACKUP_VERSION = 1

interface OpenCodeSessionListItem {
	id: string
}

interface PortableServerSettings {
	servers: Array<{
		id: string
		name: string
		type: "local" | "remote" | "ssh"
		url?: string
		sshHost?: string
		sshUser?: string
	}>
	activeServerId: string
}

export interface ServerBackupFile {
	format: typeof BACKUP_FORMAT
	version: typeof BACKUP_VERSION
	exportedAt: string
	servers: PortableServerSettings
	credentials: Record<string, string>
	opencodeAuth: string | null
	sessions: unknown[]
}

export interface ServerBackupImportResult {
	success: boolean
	serverCount: number
	credentialCount: number
	sessionCount: number
	failedSessionCount: number
	error?: string
}

function openCodeAuthPath(): string {
	const dataRoot = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share")
	return path.join(dataRoot, "opencode", "auth.json")
}

async function readOpenCodeAuth(): Promise<string | null> {
	try {
		return await readFile(openCodeAuthPath(), "utf8")
	} catch {
		return null
	}
}

async function writeOpenCodeAuth(contents: string | null): Promise<void> {
	if (contents === null) return
	const authPath = openCodeAuthPath()
	await mkdir(path.dirname(authPath), { recursive: true })
	await writeFile(authPath, contents, { encoding: "utf8", mode: 0o600 })
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isServerConfig(value: unknown): boolean {
	if (!isRecord(value)) return false
	if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.type !== "string") {
		return false
	}
	if (value.type === "local") return value.id === "local"
	if (value.type === "remote") return typeof value.url === "string"
	if (value.type === "ssh") return typeof value.sshHost === "string" && typeof value.sshUser === "string"
	return false
}

function parseBackup(raw: string): ServerBackupFile {
	const value: unknown = JSON.parse(raw)
	if (!isRecord(value) || value.format !== BACKUP_FORMAT || value.version !== BACKUP_VERSION) {
		throw new Error("This is not a supported EIGENT server backup file.")
	}
	if (!isRecord(value.servers)) throw new Error("Backup is missing server settings.")
	const settings = value.servers
	if (!Array.isArray(settings.servers) || !settings.servers.every(isServerConfig)) {
		throw new Error("Backup contains invalid server settings.")
	}
	if (
		typeof settings.activeServerId !== "string" ||
		!settings.servers.some((server) => isRecord(server) && server.id === settings.activeServerId)
	) {
		throw new Error("Backup contains an invalid active server setting.")
	}
	if (!isRecord(value.credentials)) throw new Error("Backup contains invalid credentials.")
	const credentials: Record<string, string> = {}
	for (const [serverId, password] of Object.entries(value.credentials)) {
		if (typeof password !== "string") throw new Error("Backup contains an invalid password entry.")
		credentials[serverId] = password
	}
	if (value.opencodeAuth !== null && typeof value.opencodeAuth !== "string") {
		throw new Error("Backup contains invalid OpenCode authentication data.")
	}
	if (!Array.isArray(value.sessions)) throw new Error("Backup contains invalid session data.")

	return {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : new Date(0).toISOString(),
		servers: settings as unknown as PortableServerSettings,
		credentials,
		opencodeAuth: value.opencodeAuth as string | null,
		sessions: value.sessions,
	}
}

async function runOpenCode(args: string[]): Promise<string> {
	const executable = process.env.EIGENT_OPENCODE_EXECUTABLE?.trim() || (process.platform === "win32" ? "opencode.exe" : "opencode")
	const proc = Bun.spawn({
		cmd: [executable, ...args],
		cwd: homedir(),
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `OpenCode exited with code ${exitCode}`)
	return stdout
}

async function exportSessions(): Promise<unknown[]> {
	const listed = JSON.parse(await runOpenCode(["session", "list", "--format", "json"])) as unknown
	if (!Array.isArray(listed)) throw new Error("OpenCode returned an invalid session list.")
	const sessionIds = listed
		.filter((item): item is OpenCodeSessionListItem => isRecord(item) && typeof item.id === "string")
		.map((item) => item.id)
	const sessions: unknown[] = []
	for (const sessionId of sessionIds) {
		sessions.push(JSON.parse(await runOpenCode(["export", sessionId])))
	}
	return sessions
}

export async function createServerBackup(): Promise<ServerBackupFile> {
	return {
		format: BACKUP_FORMAT,
		version: BACKUP_VERSION,
		exportedAt: new Date().toISOString(),
		servers: {
			servers: [{ id: "local", name: "EIGENT Server", type: "local" }],
			activeServerId: "local",
		},
		credentials: {},
		opencodeAuth: await readOpenCodeAuth(),
		sessions: await exportSessions(),
	}
}

async function importSessions(sessions: unknown[]): Promise<{ imported: number; failed: number }> {
	if (sessions.length === 0) return { imported: 0, failed: 0 }
	const tempDir = path.join(tmpdir(), `eigent-backup-${randomUUID()}`)
	await mkdir(tempDir, { recursive: true })
	let imported = 0
	let failed = 0
	try {
		for (let index = 0; index < sessions.length; index++) {
			const filePath = path.join(tempDir, `session-${index}.json`)
			await writeFile(filePath, JSON.stringify(sessions[index]), { encoding: "utf8", mode: 0o600 })
			try {
				await runOpenCode(["import", filePath])
				imported += 1
			} catch {
				failed += 1
			}
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true })
	}
	return { imported, failed }
}

export async function restoreServerBackup(raw: string): Promise<ServerBackupImportResult> {
	const backup = parseBackup(raw)
	await writeOpenCodeAuth(backup.opencodeAuth)
	const sessions = await importSessions(backup.sessions)
	return {
		success: sessions.failed === 0,
		serverCount: backup.servers.servers.length,
		credentialCount: Object.keys(backup.credentials).length,
		sessionCount: sessions.imported,
		failedSessionCount: sessions.failed,
		error: sessions.failed > 0 ? `${sessions.failed} session(s) could not be restored. Authentication data was restored.` : undefined,
	}
}
