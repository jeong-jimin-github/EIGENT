import { randomUUID } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { app, dialog } from "electron"
import type { ServerConfig, ServerSettings } from "../preload/api"
import { deleteCredential, getCredential, storeCredential } from "./credential-store"
import { createLogger } from "./logger"
import { runOpenCode } from "./opencode-cli"
import { getSettings, updateSettings } from "./settings-store"

const log = createLogger("server-backup")
const BACKUP_FORMAT = "eigent-server-backup"
const BACKUP_VERSION = 1

interface OpenCodeSessionListItem {
	id: string
}

interface ServerBackupFile {
	format: typeof BACKUP_FORMAT
	version: typeof BACKUP_VERSION
	exportedAt: string
	servers: ServerSettings
	credentials: Record<string, string>
	opencodeAuth: string | null
	sessions: unknown[]
}

export interface ServerBackupResult {
	success: boolean
	canceled?: boolean
	path?: string
	serverCount?: number
	credentialCount?: number
	sessionCount?: number
	failedSessionCount?: number
	error?: string
}

function getOpenCodeAuthPath(): string {
	const dataRoot = process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share")
	return path.join(dataRoot, "opencode", "auth.json")
}

async function readOpenCodeAuth(): Promise<string | null> {
	try {
		return await readFile(getOpenCodeAuthPath(), "utf8")
	} catch {
		return null
	}
}

async function writeOpenCodeAuth(contents: string | null): Promise<void> {
	if (contents === null) return
	const authPath = getOpenCodeAuthPath()
	await mkdir(path.dirname(authPath), { recursive: true })
	await writeFile(authPath, contents, { encoding: "utf8", mode: 0o600 })
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isServerConfig(value: unknown): value is ServerConfig {
	if (!isRecord(value)) return false
	if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.type !== "string") {
		return false
	}
	if (value.type === "local") return value.id === "local"
	if (value.type === "remote") return typeof value.url === "string"
	if (value.type === "ssh") {
		return typeof value.sshHost === "string" && typeof value.sshUser === "string"
	}
	return false
}

function parseBackup(raw: string): ServerBackupFile {
	const value: unknown = JSON.parse(raw)
	if (!isRecord(value) || value.format !== BACKUP_FORMAT || value.version !== BACKUP_VERSION) {
		throw new Error("This is not a supported EIGENT server backup file.")
	}
	if (!isRecord(value.servers)) throw new Error("Backup is missing server settings.")
	const serverSettings = value.servers
	const servers = serverSettings.servers
	if (!Array.isArray(servers) || !servers.every(isServerConfig)) {
		throw new Error("Backup contains invalid server settings.")
	}
	const activeServerId = serverSettings.activeServerId
	if (typeof activeServerId !== "string" || !servers.some((server) => server.id === activeServerId)) {
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
		servers: { servers, activeServerId },
		credentials,
		opencodeAuth: value.opencodeAuth,
		sessions: value.sessions,
	}
}

async function exportSessions(): Promise<unknown[]> {
	const { stdout } = await runOpenCode(["session", "list", "--format", "json"])
	const listed: unknown = JSON.parse(stdout)
	if (!Array.isArray(listed)) throw new Error("OpenCode returned an invalid session list.")

	const sessionIds = listed
		.filter((item): item is OpenCodeSessionListItem => isRecord(item) && typeof item.id === "string")
		.map((item) => item.id)
	const sessions: unknown[] = []
	for (const sessionId of sessionIds) {
		const exported = await runOpenCode(["export", sessionId])
		sessions.push(JSON.parse(exported.stdout))
	}
	return sessions
}

export async function exportServerBackup(): Promise<ServerBackupResult> {
	try {
		const stamp = new Date().toISOString().slice(0, 10)
		const result = await dialog.showSaveDialog({
			title: "Export EIGENT Server Backup",
			defaultPath: path.join(app.getPath("documents"), `eigent-server-backup-${stamp}.json`),
			filters: [{ name: "EIGENT Backup", extensions: ["json"] }],
		})
		if (result.canceled || !result.filePath) return { success: false, canceled: true }

		const settings = getSettings()
		const credentials: Record<string, string> = {}
		for (const server of settings.servers.servers) {
			const password = getCredential(server.id)
			if (password !== null) credentials[server.id] = password
		}

		const sessions = await exportSessions()
		const backup: ServerBackupFile = {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exportedAt: new Date().toISOString(),
			servers: structuredClone(settings.servers),
			credentials,
			opencodeAuth: await readOpenCodeAuth(),
			sessions,
		}

		await writeFile(result.filePath, JSON.stringify(backup, null, 2), { encoding: "utf8", mode: 0o600 })
		return {
			success: true,
			path: result.filePath,
			serverCount: backup.servers.servers.length,
			credentialCount: Object.keys(credentials).length,
			sessionCount: sessions.length,
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		log.error("Failed to export server backup", error)
		return { success: false, error: message }
	}
}

async function importSessions(sessions: unknown[]): Promise<{ imported: number; failed: number }> {
	if (sessions.length === 0) return { imported: 0, failed: 0 }
	const tempDir = path.join(app.getPath("temp"), `eigent-backup-${randomUUID()}`)
	await mkdir(tempDir, { recursive: true })
	let imported = 0
	let failed = 0
	try {
		for (let index = 0; index < sessions.length; index++) {
			const filePath = path.join(tempDir, `session-${index}.json`)
			await writeFile(filePath, JSON.stringify(sessions[index]), "utf8")
			try {
				await runOpenCode(["import", filePath])
				imported++
			} catch (error) {
				failed++
				log.warn("Failed to import OpenCode session", { index, error: String(error) })
			}
		}
	} finally {
		await rm(tempDir, { recursive: true, force: true })
	}
	return { imported, failed }
}

export async function importServerBackup(): Promise<ServerBackupResult> {
	try {
		const result = await dialog.showOpenDialog({
			title: "Import EIGENT Server Backup",
			properties: ["openFile"],
			filters: [{ name: "EIGENT Backup", extensions: ["json"] }],
		})
		if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true }

		const filePath = result.filePaths[0]
		const backup = parseBackup(await readFile(filePath, "utf8"))

		const oldServerIds = getSettings().servers.servers.map((server) => server.id)
		const allCredentialIds = new Set([
			...oldServerIds,
			...backup.servers.servers.map((server) => server.id),
		])
		for (const serverId of allCredentialIds) deleteCredential(serverId)
		for (const [serverId, password] of Object.entries(backup.credentials)) {
			storeCredential(serverId, password)
		}
		await writeOpenCodeAuth(backup.opencodeAuth)
		updateSettings({ servers: backup.servers })

		const sessionResult = await importSessions(backup.sessions)
		return {
			success: sessionResult.failed === 0,
			path: filePath,
			serverCount: backup.servers.servers.length,
			credentialCount: Object.keys(backup.credentials).length,
			sessionCount: sessionResult.imported,
			failedSessionCount: sessionResult.failed,
			error:
				sessionResult.failed > 0
					? `${sessionResult.failed} session(s) could not be restored. Server settings and credentials were restored.`
					: undefined,
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		log.error("Failed to import server backup", error)
		return { success: false, error: message }
	}
}
