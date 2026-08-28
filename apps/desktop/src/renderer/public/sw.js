const CACHE_NAME = "eigent-shell-v2"
const APP_SHELL = ["/", "/manifest.webmanifest", "/favicon.png", "/pwa-icon.png"]

self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
	self.skipWaiting()
})

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
	)
	self.clients.claim()
})

self.addEventListener("push", (event) => {
	let payload = {}
	try {
		payload = event.data?.json() ?? {}
	} catch {
		payload = { body: event.data?.text() ?? "EIGENT needs your attention." }
	}

	event.waitUntil(
		self.registration.showNotification(payload.title || "EIGENT", {
			body: payload.body || "EIGENT needs your attention.",
			icon: "/pwa-icon.png",
			badge: "/pwa-icon.png",
			tag: payload.tag || "eigent:notification",
			renotify: false,
			data: {
				url: payload.url || "/",
				sessionId: payload.sessionId,
				uiSessionId: payload.uiSessionId,
			},
		}),
	)
})

self.addEventListener("notificationclick", (event) => {
	event.notification.close()
	const data = event.notification.data || {}
	const targetUrl = new URL(data.url || "/", self.location.origin).href

	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
			const sameOrigin = clients.find((client) => new URL(client.url).origin === self.location.origin)
			if (sameOrigin) {
				sameOrigin.postMessage({
					type: "eigent:notification-click",
					sessionId: data.sessionId,
					uiSessionId: data.uiSessionId,
				})
				await sameOrigin.focus()
				return
			}
			await self.clients.openWindow(targetUrl)
		}),
	)
})

self.addEventListener("fetch", (event) => {
	const request = event.request
	if (request.method !== "GET") return

	const url = new URL(request.url)
	if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return

	if (request.mode === "navigate") {
		event.respondWith(
			fetch(request).catch(() => caches.match("/").then((response) => response || Response.error())),
		)
		return
	}

	event.respondWith(
		caches.match(request).then((cached) => {
			if (cached) return cached
			return fetch(request).then((response) => {
				if (response.ok) {
					const copy = response.clone()
					caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
				}
				return response
			})
		}),
	)
})
