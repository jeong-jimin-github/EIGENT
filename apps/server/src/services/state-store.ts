/** Durable SQLite state store for EIGENT server lifecycle and reconnect recovery. */

import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
	AgentEvent,
	AgentProviderKind,
	AgentSession,
	AgentSessionSnapshot,
	AgentSessionState,
} from "@eigent/agent-core"
import type { ManagedProcessInfo, ManagedProcessState } from "./process-types"

export interface PersistedAgentEvent {
	sequence: number
	event: AgentEvent
	createdAt: number
}

export interface PersistedAgentSession {
	session: AgentSession
	driverState?: unknown
	updatedAt: number
}

export type PersistentTaskState = AgentSessionState | "pending"

export interface PersistentTask {
	id: string
	workspace: string
	title: string
	state: PersistentTaskState
	createdAt: number
	updatedAt: number
}

interface AgentSessionRow {
	id: string
	task_id: string | null
	provider: string
	model: string
	workspace: string
	state: string
	created_at: number
	updated_at: number
	driver_state_json: string | null
}

interface TaskRow {
	id: string
	workspace: string
	title: string
	state: string
	created_at: number
	updated_at: number
}

interface AgentEventRow {
	sequence: number
	payload_json: string
	created_at: number
}

interface ProcessRow {
	id: string
	task_id: string | null
	command: string
	cwd: string
	pid: number | null
	state: string
	exit_code: number | null
	started_at: number
	ended_at: number | null
	output: string
}

const ACTIVE_SESSION_STATES: AgentSessionState[] = ["starting", "running", "waiting_input"]

function defaultDatabasePath(): string {
	if (process.env.EIGENT_STATE_DB) return process.env.EIGENT_STATE_DB
	if (process.env.EIGENT_DATA_DIR) return path.join(process.env.EIGENT_DATA_DIR, "eigent.db")
	const dataHome =
		process.env.XDG_DATA_HOME ??
		(process.platform === "win32"
			? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"))
			: path.join(os.homedir(), ".local", "share"))
	return path.join(dataHome, "eigent", "eigent.db")
}

function safeJsonParse(value: string | null): unknown {
	if (!value) return undefined
	try {
		return JSON.parse(value)
	} catch {
		return undefined
	}
}

export class StateStore {
	private readonly db: Database

	constructor(filename = defaultDatabasePath()) {
		if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true })
		this.db = new Database(filename, { create: true })
		this.db.exec("PRAGMA foreign_keys = ON")
		if (filename !== ":memory:") {
			this.db.exec("PRAGMA journal_mode = WAL")
			this.db.exec("PRAGMA synchronous = NORMAL")
		}
		this.migrate()
	}

	private migrate() {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version INTEGER PRIMARY KEY,
				applied_at INTEGER NOT NULL
			)
		`)
		const row = this.db
			.query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
			.get() as { version: number }
		if (row.version >= 1) return

		const migration = this.db.transaction(() => {
			this.db.exec(`
				CREATE TABLE workspaces (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					path TEXT NOT NULL UNIQUE,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL
				);
				CREATE TABLE tasks (
					id TEXT PRIMARY KEY,
					workspace_id INTEGER,
					title TEXT NOT NULL,
					state TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
				);
				CREATE TABLE agent_sessions (
					id TEXT PRIMARY KEY,
					task_id TEXT,
					provider TEXT NOT NULL,
					model TEXT NOT NULL,
					workspace TEXT NOT NULL,
					state TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					driver_state_json TEXT,
					FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
				);
				CREATE TABLE agent_events (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					session_id TEXT NOT NULL,
					sequence INTEGER NOT NULL,
					event_type TEXT NOT NULL,
					payload_json TEXT NOT NULL,
					created_at INTEGER NOT NULL,
					FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
					UNIQUE(session_id, sequence)
				);
				CREATE TABLE managed_processes (
					id TEXT PRIMARY KEY,
					task_id TEXT,
					command TEXT NOT NULL,
					cwd TEXT NOT NULL,
					pid INTEGER,
					state TEXT NOT NULL,
					exit_code INTEGER,
					started_at INTEGER NOT NULL,
					ended_at INTEGER,
					output TEXT NOT NULL DEFAULT '',
					updated_at INTEGER NOT NULL,
					FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
				);
				CREATE INDEX agent_events_session_sequence_idx
					ON agent_events(session_id, sequence);
				CREATE INDEX agent_sessions_workspace_updated_idx
					ON agent_sessions(workspace, updated_at DESC);
				CREATE INDEX managed_processes_started_idx
					ON managed_processes(started_at DESC);
			`)
			this.db
				.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
				.run(1, Date.now())
		})
		migration()
	}

	close() {
		this.db.close()
	}

	getSchemaVersion(): number {
		const row = this.db
			.query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
			.get() as { version: number }
		return row.version
	}

	upsertWorkspace(workspace: string): number {
		const now = Date.now()
		this.db
			.query(`
				INSERT INTO workspaces(path, created_at, updated_at)
				VALUES (?, ?, ?)
				ON CONFLICT(path) DO UPDATE SET updated_at = excluded.updated_at
			`)
			.run(workspace, now, now)
		const row = this.db.query("SELECT id FROM workspaces WHERE path = ?").get(workspace) as {
			id: number
		}
		return row.id
	}

	createTask(workspace: string, title: string): PersistentTask {
		const now = Date.now()
		const id = randomUUID()
		const workspaceId = this.upsertWorkspace(workspace)
		this.db
			.query(`
				INSERT INTO tasks(id, workspace_id, title, state, created_at, updated_at)
				VALUES (?, ?, ?, 'pending', ?, ?)
			`)
			.run(id, workspaceId, title, now, now)
		return { id, workspace, title, state: "pending", createdAt: now, updatedAt: now }
	}

	private taskFromRow(row: TaskRow): PersistentTask {
		return {
			id: row.id,
			workspace: row.workspace,
			title: row.title,
			state: row.state as PersistentTaskState,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}
	}

	getTask(id: string): PersistentTask | null {
		const row = this.db
			.query(`
				SELECT tasks.*, workspaces.path AS workspace
				FROM tasks
				JOIN workspaces ON workspaces.id = tasks.workspace_id
				WHERE tasks.id = ?
			`)
			.get(id) as TaskRow | null
		return row ? this.taskFromRow(row) : null
	}

	listTasks(workspace?: string): PersistentTask[] {
		const rows = (
			workspace
				? this.db
						.query(`
						SELECT tasks.*, workspaces.path AS workspace
						FROM tasks
						JOIN workspaces ON workspaces.id = tasks.workspace_id
						WHERE workspaces.path = ?
						ORDER BY tasks.updated_at DESC
					`)
						.all(workspace)
				: this.db
						.query(`
						SELECT tasks.*, workspaces.path AS workspace
						FROM tasks
						JOIN workspaces ON workspaces.id = tasks.workspace_id
						ORDER BY tasks.updated_at DESC
					`)
						.all()
		) as TaskRow[]
		return rows.map((row) => this.taskFromRow(row))
	}

	updateTask(
		id: string,
		updates: { title?: string; state?: PersistentTaskState },
	): PersistentTask | null {
		const current = this.getTask(id)
		if (!current) return null
		const title = updates.title ?? current.title
		const state = updates.state ?? current.state
		const updatedAt = Date.now()
		this.db
			.query("UPDATE tasks SET title = ?, state = ?, updated_at = ? WHERE id = ?")
			.run(title, state, updatedAt, id)
		return { ...current, title, state, updatedAt }
	}

	saveAgentSnapshot(snapshot: AgentSessionSnapshot) {
		const now = Date.now()
		this.upsertWorkspace(snapshot.session.workspace)
		this.db
			.query(`
				INSERT INTO agent_sessions(
					id, task_id, provider, model, workspace, state, created_at, updated_at, driver_state_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					task_id = excluded.task_id,
					provider = excluded.provider,
					model = excluded.model,
					workspace = excluded.workspace,
					state = excluded.state,
					updated_at = excluded.updated_at,
					driver_state_json = excluded.driver_state_json
			`)
			.run(
				snapshot.session.id,
				snapshot.session.taskId ?? null,
				snapshot.session.provider,
				snapshot.session.model,
				snapshot.session.workspace,
				snapshot.session.state,
				snapshot.session.createdAt,
				now,
				snapshot.driverState === undefined ? null : JSON.stringify(snapshot.driverState),
			)
	}

	private sessionFromRow(row: AgentSessionRow): PersistedAgentSession {
		return {
			session: {
				id: row.id,
				provider: row.provider as AgentProviderKind,
				model: row.model,
				workspace: row.workspace,
				taskId: row.task_id ?? undefined,
				state: row.state as AgentSessionState,
				createdAt: row.created_at,
			},
			driverState: safeJsonParse(row.driver_state_json),
			updatedAt: row.updated_at,
		}
	}

	getAgentSession(id: string): PersistedAgentSession | null {
		const row = this.db
			.query("SELECT * FROM agent_sessions WHERE id = ?")
			.get(id) as AgentSessionRow | null
		return row ? this.sessionFromRow(row) : null
	}

	listAgentSessions(workspace?: string): PersistedAgentSession[] {
		const rows = (
			workspace
				? this.db
						.query("SELECT * FROM agent_sessions WHERE workspace = ? ORDER BY updated_at DESC")
						.all(workspace)
				: this.db.query("SELECT * FROM agent_sessions ORDER BY updated_at DESC").all()
		) as AgentSessionRow[]
		return rows.map((row) => this.sessionFromRow(row))
	}

	appendAgentEvent(sessionId: string, event: AgentEvent): PersistedAgentEvent {
		const now = Date.now()
		const insert = this.db.transaction(() => {
			const row = this.db
				.query(
					"SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_events WHERE session_id = ?",
				)
				.get(sessionId) as { sequence: number }
			this.db
				.query(`
					INSERT INTO agent_events(session_id, sequence, event_type, payload_json, created_at)
					VALUES (?, ?, ?, ?, ?)
				`)
				.run(sessionId, row.sequence, event.type, JSON.stringify(event), now)
			if (event.type === "state.changed") {
				this.db
					.query("UPDATE agent_sessions SET state = ?, updated_at = ? WHERE id = ?")
					.run(event.state, now, sessionId)
				this.db
					.query(`
						UPDATE tasks SET state = ?, updated_at = ?
						WHERE id = (SELECT task_id FROM agent_sessions WHERE id = ?)
					`)
					.run(event.state, now, sessionId)
			}
			return row.sequence
		})
		return { sequence: insert(), event, createdAt: now }
	}

	getLastAgentEventSequence(sessionId: string): number {
		const row = this.db
			.query("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_events WHERE session_id = ?")
			.get(sessionId) as { sequence: number }
		return row.sequence
	}

	listAgentEvents(sessionId: string, afterSequence = 0): PersistedAgentEvent[] {
		const rows = this.db
			.query(`
				SELECT sequence, payload_json, created_at
				FROM agent_events
				WHERE session_id = ? AND sequence > ?
				ORDER BY sequence ASC
			`)
			.all(sessionId, afterSequence) as AgentEventRow[]
		return rows.map((row) => ({
			sequence: row.sequence,
			event: JSON.parse(row.payload_json) as AgentEvent,
			createdAt: row.created_at,
		}))
	}

	markActiveAgentSessionsInterrupted(): number {
		const placeholders = ACTIVE_SESSION_STATES.map(() => "?").join(", ")
		const now = Date.now()
		const reconcile = this.db.transaction(() => {
			const active = this.db
				.query(`
					SELECT id FROM agent_sessions
					WHERE state IN (${placeholders})
				`)
				.all(...ACTIVE_SESSION_STATES) as Array<{ id: string }>
			if (active.length === 0) return 0

			this.db
				.query(`
					UPDATE tasks SET state = 'interrupted', updated_at = ?
					WHERE id IN (
						SELECT task_id FROM agent_sessions
						WHERE task_id IS NOT NULL AND state IN (${placeholders})
					)
				`)
				.run(now, ...ACTIVE_SESSION_STATES)
			this.db
				.query(`
					UPDATE agent_sessions
					SET state = 'interrupted', updated_at = ?
					WHERE state IN (${placeholders})
				`)
				.run(now, ...ACTIVE_SESSION_STATES)

			const event = JSON.stringify({
				type: "state.changed",
				state: "interrupted",
			} satisfies AgentEvent)
			for (const { id } of active) {
				const row = this.db
					.query(
						"SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_events WHERE session_id = ?",
					)
					.get(id) as { sequence: number }
				this.db
					.query(`
						INSERT INTO agent_events(session_id, sequence, event_type, payload_json, created_at)
						VALUES (?, ?, 'state.changed', ?, ?)
					`)
					.run(id, row.sequence, event, now)
			}
			return active.length
		})
		return reconcile()
	}

	saveManagedProcess(info: ManagedProcessInfo) {
		const now = Date.now()
		this.upsertWorkspace(info.cwd)
		this.db
			.query(`
				INSERT INTO managed_processes(
					id, task_id, command, cwd, pid, state, exit_code, started_at, ended_at, output, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					task_id = excluded.task_id,
					command = excluded.command,
					cwd = excluded.cwd,
					pid = excluded.pid,
					state = excluded.state,
					exit_code = excluded.exit_code,
					ended_at = excluded.ended_at,
					output = excluded.output,
					updated_at = excluded.updated_at
			`)
			.run(
				info.id,
				info.taskId ?? null,
				info.command,
				info.cwd,
				info.pid,
				info.state,
				info.exitCode,
				info.startedAt,
				info.endedAt,
				info.output,
				now,
			)
	}

	listManagedProcesses(): ManagedProcessInfo[] {
		const rows = this.db
			.query("SELECT * FROM managed_processes ORDER BY started_at DESC")
			.all() as ProcessRow[]
		return rows.map((row) => ({
			id: row.id,
			command: row.command,
			cwd: row.cwd,
			taskId: row.task_id ?? undefined,
			pid: row.pid,
			state: row.state as ManagedProcessState,
			exitCode: row.exit_code,
			startedAt: row.started_at,
			endedAt: row.ended_at,
			output: row.output,
		}))
	}

	markRunningProcessesOrphaned(): number {
		const now = Date.now()
		const marker = "\n[EIGENT: process connection was lost during server restart]\n"
		const result = this.db
			.query(`
				UPDATE managed_processes
				SET state = 'orphaned', pid = NULL, ended_at = COALESCE(ended_at, ?),
					output = output || ?, updated_at = ?
				WHERE state = 'running'
			`)
			.run(now, marker, now)
		return result.changes
	}

	deleteManagedProcess(id: string) {
		this.db.query("DELETE FROM managed_processes WHERE id = ?").run(id)
	}
}
