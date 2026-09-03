export interface OpenCodeEventBridgeOptions {
	ensureServerUrl: () => Promise<string>
	getServerUrl: () => string | null
	fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
	retryDelayMs?: number
	keepAliveMs?: number
	onError?: (error: unknown) => void
}

const DEFAULT_RETRY_DELAY_MS = 250
const DEFAULT_KEEP_ALIVE_MS = 15_000
const KEEP_ALIVE = new TextEncoder().encode(": eigent-opencode-idle\n\n")

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Keep the browser's global OpenCode SSE subscription alive without pinning the
 * heavyweight OpenCode child process in memory. The bridge starts OpenCode only
 * for the initial subscription. If the managed child later idles out, the bridge
 * waits for a real API request to restart it, then reconnects transparently.
 */
export function createOpenCodeEventBridge(
	options: OpenCodeEventBridgeOptions,
): ReadableStream<Uint8Array> {
	const fetchImpl = options.fetchImpl ?? fetch
	const retryDelayMs = Math.max(10, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
	const keepAliveMs = Math.max(100, options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS)

	let stopped = false
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
	let upstreamAbort: AbortController | null = null

	async function closeUpstream(reason?: unknown): Promise<void> {
		upstreamAbort?.abort()
		upstreamAbort = null
		const currentReader = reader
		reader = null
		if (!currentReader) return
		try {
			await currentReader.cancel(reason)
		} catch {
			// The OpenCode child may already have exited and closed the stream.
		}
	}

	return new ReadableStream<Uint8Array>({
		start(controller) {
			void (async () => {
				let initialConnection = true
				let lastKeepAliveAt = Date.now()

				while (!stopped) {
					let serverUrl = options.getServerUrl()
					if (initialConnection) {
						// Consume the one allowed ensure even when the runtime was already up.
						// After an idle shutdown this bridge must wait for real API activity,
						// never restart OpenCode on its own.
						initialConnection = false
						if (!serverUrl) {
							try {
								serverUrl = await options.ensureServerUrl()
							} catch (error) {
								options.onError?.(error)
							}
						}
					}

					if (!serverUrl) {
						const now = Date.now()
						if (now - lastKeepAliveAt >= keepAliveMs) {
							controller.enqueue(KEEP_ALIVE.slice())
							lastKeepAliveAt = now
						}
						await delay(retryDelayMs)
						continue
					}

					try {
						upstreamAbort = new AbortController()
						const upstream = await fetchImpl(`${serverUrl}/global/event`, {
							headers: { accept: "text/event-stream" },
							signal: upstreamAbort.signal,
						})
						if (!upstream.ok || !upstream.body) {
							throw new Error(`OpenCode global event returned HTTP ${upstream.status}`)
						}

						reader = upstream.body.getReader()
						while (!stopped) {
							const chunk = await reader.read()
							if (chunk.done) break
							controller.enqueue(chunk.value)
							lastKeepAliveAt = Date.now()
						}
					} catch (error) {
						if (!stopped) options.onError?.(error)
					} finally {
						await closeUpstream()
					}

					if (!stopped) await delay(retryDelayMs)
				}

				try {
					controller.close()
				} catch {
					// The downstream may already have cancelled the stream.
				}
			})()
		},
		async cancel(reason) {
			stopped = true
			await closeUpstream(reason)
		},
	})
}
