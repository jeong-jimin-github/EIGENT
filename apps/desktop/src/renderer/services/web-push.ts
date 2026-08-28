export interface WebPushCategories {
	completion: boolean
	failure: boolean
	question: boolean
	permission: boolean
	reconnect: boolean
}

export interface WebPushConfig {
	enabled: boolean
	publicKey: string | null
}

export const DEFAULT_WEB_PUSH_CATEGORIES: WebPushCategories = {
	completion: true,
	failure: true,
	question: true,
	permission: true,
	reconnect: true,
}

const CATEGORIES_KEY = "eigent:webPushCategories"

function requestHeaders(): HeadersInit {
	return { "content-type": "application/json" }
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init)
	const data = (await response.json()) as T & { error?: string }
	if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`)
	return data
}

function applicationServerKey(value: string): ArrayBuffer {
	const padding = "=".repeat((4 - (value.length % 4)) % 4)
	const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/")
	const raw = atob(base64)
	const buffer = new ArrayBuffer(raw.length)
	const bytes = new Uint8Array(buffer)
	for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
	return buffer
}

export function supportsWebPush(): boolean {
	return (
		typeof window !== "undefined" &&
		!("palot" in window) &&
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window
	)
}

export function loadWebPushCategories(): WebPushCategories {
	try {
		const parsed = JSON.parse(localStorage.getItem(CATEGORIES_KEY) || "{}") as Partial<WebPushCategories>
		return { ...DEFAULT_WEB_PUSH_CATEGORIES, ...parsed }
	} catch {
		return { ...DEFAULT_WEB_PUSH_CATEGORIES }
	}
}

export function saveWebPushCategories(categories: WebPushCategories): void {
	localStorage.setItem(CATEGORIES_KEY, JSON.stringify(categories))
}

export async function fetchWebPushConfig(): Promise<WebPushConfig> {
	return jsonRequest<WebPushConfig>("/api/push/config")
}

async function getRegistration(): Promise<ServiceWorkerRegistration> {
	const existing = await navigator.serviceWorker.getRegistration("/")
	if (existing) return existing
	return navigator.serviceWorker.register("/sw.js")
}

export async function getWebPushSubscription(): Promise<PushSubscription | null> {
	if (!supportsWebPush()) return null
	const registration = await getRegistration()
	return registration.pushManager.getSubscription()
}

async function syncSubscription(
	subscription: PushSubscription,
	categories: WebPushCategories,
): Promise<void> {
	const json = subscription.toJSON()
	if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
		throw new Error("Browser returned an incomplete push subscription")
	}
	await jsonRequest("/api/push/subscriptions", {
		method: "POST",
		headers: requestHeaders(),
		body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, categories }),
	})
}

export async function subscribeWebPush(
	categories: WebPushCategories = loadWebPushCategories(),
): Promise<PushSubscription> {
	if (!supportsWebPush()) throw new Error("Web Push is not supported in this browser")
	const config = await fetchWebPushConfig()
	if (!config.enabled || !config.publicKey) throw new Error("Web Push is not configured on the server")
	const permission = await Notification.requestPermission()
	if (permission !== "granted") throw new Error("Notification permission was not granted")
	const registration = await getRegistration()
	let subscription = await registration.pushManager.getSubscription()
	if (!subscription) {
		subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: applicationServerKey(config.publicKey),
		})
	}
	saveWebPushCategories(categories)
	await syncSubscription(subscription, categories)
	return subscription
}

export async function updateWebPushCategories(categories: WebPushCategories): Promise<void> {
	saveWebPushCategories(categories)
	const subscription = await getWebPushSubscription()
	if (subscription) await syncSubscription(subscription, categories)
}

export async function unsubscribeWebPush(): Promise<void> {
	const subscription = await getWebPushSubscription()
	if (!subscription) return
	try {
		await jsonRequest("/api/push/subscriptions", {
			method: "DELETE",
			headers: requestHeaders(),
			body: JSON.stringify({ endpoint: subscription.endpoint }),
		})
	} finally {
		await subscription.unsubscribe()
	}
}

export async function showReconnectFailureNotification(): Promise<void> {
	if (!supportsWebPush() || Notification.permission !== "granted") return
	if (!loadWebPushCategories().reconnect) return
	const registration = await navigator.serviceWorker.getRegistration("/")
	if (!registration) return
	await registration.showNotification("EIGENT connection lost", {
		body: "The app cannot reconnect to the server. Background agent tasks may still be running.",
		icon: "/pwa-icon.png",
		tag: "eigent:reconnect",
		data: { url: "/" },
	})
}
