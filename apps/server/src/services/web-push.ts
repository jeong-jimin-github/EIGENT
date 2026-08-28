import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AgentEvent, AgentSession } from "@eigent/agent-core"
import webpush, { type PushSubscription as WebPushSubscription } from "web-push"

export type PushCategory = "completion" | "failure" | "question" | "permission" | "reconnect"

export interface PushCategories {
	completion: boolean
	failure: boolean
	question: boolean
	permission: boolean
	reconnect: boolean
}

export interface StoredPushSubscription {
	endpoint: string
	keys: { p256dh: string; auth: string }
	categories: PushCategories
	createdAt: number
	updatedAt: number
}

export interface AgentPushMessage {
	category: PushCategory
	title: string
	body: string
	tag: string
	sessionId: string
	uiSessionId?: string
	url: string
}

interface StoredPushState {
	subscriptions: StoredPushSubscription[]
	sessionLinks: Record<string, string>
}

const DEFAULT_CATEGORIES: PushCategories = {
	completion: true,
	failure: true,
	question: true,
	permission: true,
	reconnect: true,
}

function dataDir(): string {
	if (process.env.EIGENT_DATA_DIR) return process.env.EIGENT_DATA_DIR
	if (process.env.EIGENT_STATE_DB && process.env.EIGENT_STATE_DB !== ":memory:") {
		return path.dirname(process.env.EIGENT_STATE_DB)
	}
	const home =
		process.env.XDG_DATA_HOME ??
		(process.platform === "win32"
			? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"))
			: path.join(os.homedir(), ".local", "share"))
	return path.join(home, "eigent")
}

function storePath(): string {
	return process.env.EIGENT_PUSH_STORE ?? path.join(dataDir(), "push-subscriptions.json")
}

function normalizeCategories(value?: Partial<PushCategories>): PushCategories {
	return { ...DEFAULT_CATEGORIES, ...(value ?? {}) }
}

function summarizeWorkspace(workspace: string): string {
	const normalized = workspace.replace(/[/]+$/, "")
	return path.basename(normalized) || workspace
}

export function notificationForAgentEvent(
	session: AgentSession,
	event: AgentEvent,
	uiSessionId?: string,
): AgentPushMessage | null {
	const project = summarizeWorkspace(session.workspace)
	const params = new URLSearchParams({ eigentSession: session.id })
	if (uiSessionId) params.set("uiSession", uiSessionId)
	const url = `/?${params}`
	switch (event.type) {
		case "run.completed":
			return {
				category: "completion",
				title: `${project} task completed`,
				body: "EIGENT finished the task.",
				tag: `eigent:${session.id}:run:${event.requestId}`,
				sessionId: session.id,
				uiSessionId,
				url,
			}
		case "run.failed":
			return {
				category: "failure",
				title: `${project} task failed`,
				body: event.message || "The agent run failed.",
				tag: `eigent:${session.id}:run:${event.requestId}`,
				sessionId: session.id,
				uiSessionId,
				url,
			}
		case "question":
			return {
				category: "question",
				title: `${project} needs an answer`,
				body: event.prompt,
				tag: `eigent:${session.id}:question:${event.id}`,
				sessionId: session.id,
				uiSessionId,
				url,
			}
		case "permission":
			return {
				category: "permission",
				title: `${project} needs permission`,
				body: event.prompt,
				tag: `eigent:${session.id}:permission:${event.id}`,
				sessionId: session.id,
				uiSessionId,
				url,
			}
		default:
			return null
	}
}

export class WebPushService {
	private readonly subscriptions = new Map<string, StoredPushSubscription>()
	private readonly sessionLinks = new Map<string, string>()
	private configured = false
	private publicKey = ""

	constructor(private readonly filename = storePath()) {
		this.load()
		this.configure()
	}

	private configure() {
		const publicKey = process.env.EIGENT_VAPID_PUBLIC_KEY?.trim()
		const privateKey = process.env.EIGENT_VAPID_PRIVATE_KEY?.trim()
		if (!publicKey || !privateKey) return
		const subject = process.env.EIGENT_VAPID_SUBJECT?.trim() || "mailto:admin@localhost"
		webpush.setVapidDetails(subject, publicKey, privateKey)
		this.publicKey = publicKey
		this.configured = true
	}

	private load() {
		if (this.filename === ":memory:") return
		try {
			if (!fs.existsSync(this.filename)) return
			const raw = JSON.parse(fs.readFileSync(this.filename, "utf8")) as
				| StoredPushSubscription[]
				| StoredPushState
			const subscriptions = Array.isArray(raw) ? raw : raw.subscriptions
			for (const item of subscriptions ?? []) {
				if (item.endpoint && item.keys?.p256dh && item.keys?.auth) {
					this.subscriptions.set(item.endpoint, {
						...item,
						categories: normalizeCategories(item.categories),
					})
				}
			}
			if (!Array.isArray(raw)) {
				for (const [agentSessionId, uiSessionId] of Object.entries(raw.sessionLinks ?? {})) {
					if (agentSessionId && uiSessionId) this.sessionLinks.set(agentSessionId, uiSessionId)
				}
			}
		} catch (error) {
			console.warn("Failed to load web-push subscriptions:", error)
		}
	}

	private persist() {
		if (this.filename === ":memory:") return
		fs.mkdirSync(path.dirname(this.filename), { recursive: true })
		const temp = `${this.filename}.tmp`
		const state: StoredPushState = {
			subscriptions: [...this.subscriptions.values()],
			sessionLinks: Object.fromEntries(this.sessionLinks),
		}
		fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8")
		fs.renameSync(temp, this.filename)
	}

	getConfig() {
		return { enabled: this.configured, publicKey: this.publicKey || null }
	}

	list(): StoredPushSubscription[] {
		return [...this.subscriptions.values()]
	}

	bindSession(agentSessionId: string, uiSessionId?: string): void {
		if (!uiSessionId) return
		this.sessionLinks.set(agentSessionId, uiSessionId)
		this.persist()
	}

	getUiSessionId(agentSessionId: string): string | undefined {
		return this.sessionLinks.get(agentSessionId)
	}

	upsert(input: {
		endpoint: string
		keys: { p256dh: string; auth: string }
		categories?: Partial<PushCategories>
	}): StoredPushSubscription {
		const now = Date.now()
		const current = this.subscriptions.get(input.endpoint)
		const value: StoredPushSubscription = {
			endpoint: input.endpoint,
			keys: input.keys,
			categories: normalizeCategories(input.categories ?? current?.categories),
			createdAt: current?.createdAt ?? now,
			updatedAt: now,
		}
		this.subscriptions.set(value.endpoint, value)
		this.persist()
		return value
	}

	remove(endpoint: string): boolean {
		const removed = this.subscriptions.delete(endpoint)
		if (removed) this.persist()
		return removed
	}

	async notify(session: AgentSession, event: AgentEvent): Promise<void> {
		if (!this.configured) return
		const message = notificationForAgentEvent(session, event, this.sessionLinks.get(session.id))
		if (!message) return
		const payload = JSON.stringify(message)
		await Promise.allSettled(
			[...this.subscriptions.values()]
				.filter((subscription) => subscription.categories[message.category])
				.map(async (subscription) => {
					try {
						await webpush.sendNotification(
							{
								endpoint: subscription.endpoint,
								keys: subscription.keys,
							} satisfies WebPushSubscription,
							payload,
							{
								TTL: 60 * 60,
								urgency: message.category === "completion" ? "normal" : "high",
							},
						)
					} catch (error) {
						const statusCode = (error as { statusCode?: number }).statusCode
						if (statusCode === 404 || statusCode === 410) this.remove(subscription.endpoint)
						else console.warn("Web push delivery failed:", error)
					}
				}),
		)
	}
}

export const webPushService = new WebPushService()
