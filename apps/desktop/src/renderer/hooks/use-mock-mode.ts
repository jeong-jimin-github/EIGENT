/**
 * Hook that manages mock mode lifecycle.
 *
 * When mock mode activates: hydrates all Jotai atoms with fixture data,
 * marks discovery as loaded, and fakes the server connection.
 *
 * When mock mode deactivates: clears mock atoms and resets discovery
 * so the real discovery flow can run.
 */
import { useAtomValue } from "jotai"
import { useEffect } from "react"
import { serverConnectedAtom, serverUrlAtom } from "../atoms/connection"
import { discoveryAtom } from "../atoms/discovery"
import { messagesFamily } from "../atoms/messages"
import { isMockModeAtom } from "../atoms/mock-mode"
import { partsFamily } from "../atoms/parts"
import { sessionFamily, sessionIdsAtom } from "../atoms/sessions"
import { appStore } from "../atoms/store"
import { sessionDiffFamily } from "../atoms/ui"
import { createLogger } from "../lib/logger"
import { disconnect } from "../services/connection-manager"
import { resetDiscoveryGuard } from "./use-discovery"

const log = createLogger("mock-mode")

type MockDataModule = typeof import("../lib/mock-data")

let mockDataPromise: Promise<MockDataModule> | null = null
let loadedMockData: MockDataModule | null = null
let mockHydrated = false

function loadMockData(): Promise<MockDataModule> {
	if (!mockDataPromise) {
		mockDataPromise = import("../lib/mock-data")
			.then((data) => {
				loadedMockData = data
				return data
			})
			.catch((err) => {
				mockDataPromise = null
				throw err
			})
	}
	return mockDataPromise
}

/**
 * Call from the root layout. Watches `isMockModeAtom` and hydrates/clears
 * Jotai atoms accordingly. Returns the current mock mode state.
 */
export function useMockMode(): boolean {
	const isMockMode = useAtomValue(isMockModeAtom)

	useEffect(() => {
		let cancelled = false

		if (isMockMode) {
			const hydrate = async () => {
				for (let attempt = 0; attempt < 2; attempt++) {
					if (cancelled) return
					try {
						const data = await loadMockData()
						if (!cancelled && !mockHydrated) activateMockMode(data)
						return
					} catch (err) {
						if (cancelled) return
						if (attempt === 1) {
							log.error("Failed to load mock data after retry", err)
							return
						}
						await new Promise((resolve) => setTimeout(resolve, 250))
					}
				}
			}
			void hydrate()
		} else if (mockHydrated && loadedMockData) {
			deactivateMockMode(loadedMockData)
		}

		return () => {
			cancelled = true
		}
	}, [isMockMode])

	return isMockMode
}

// ============================================================
// Activation
// ============================================================

function activateMockMode(data: MockDataModule): void {
	log.info("Activating mock mode")

	// Disconnect from real server if connected
	disconnect()

	// 1. Hydrate discovery (marks loaded=true so useDiscovery() no-ops)
	appStore.set(discoveryAtom, data.MOCK_DISCOVERY)

	// 2. Hydrate sessions
	appStore.set(sessionIdsAtom, new Set(data.MOCK_SESSION_IDS))
	for (const [sessionId, entry] of data.MOCK_SESSION_ENTRIES) {
		appStore.set(sessionFamily(sessionId), entry)
	}

	// 3. Hydrate messages and parts
	for (const [sessionId, messages] of data.MOCK_MESSAGES) {
		appStore.set(messagesFamily(sessionId), messages)
	}
	for (const [, sessionParts] of data.MOCK_PARTS) {
		for (const [messageId, parts] of Object.entries(sessionParts)) {
			appStore.set(partsFamily(messageId), parts)
		}
	}

	// 4. Hydrate diffs
	for (const [sessionId, diffs] of data.MOCK_DIFFS) {
		appStore.set(sessionDiffFamily(sessionId), diffs)
	}

	// 5. Fake server connection state
	appStore.set(serverUrlAtom, "http://mock-server:3100")
	appStore.set(serverConnectedAtom, true)
	mockHydrated = true

	log.info("Mock mode activated", {
		sessions: data.MOCK_SESSION_IDS.size,
		messages: data.MOCK_MESSAGES.size,
	})
}

// ============================================================
// Deactivation
// ============================================================

function deactivateMockMode(data: MockDataModule): void {
	log.info("Deactivating mock mode")

	// 1. Clear session atoms
	for (const sessionId of data.MOCK_SESSION_IDS) {
		appStore.set(sessionFamily(sessionId), null)
	}
	appStore.set(sessionIdsAtom, new Set<string>())

	// 2. Clear message and part atoms
	for (const [sessionId, messages] of data.MOCK_MESSAGES) {
		appStore.set(messagesFamily(sessionId), [])
		for (const msg of messages) {
			appStore.set(partsFamily(msg.id), [])
		}
	}

	// 3. Clear diff atoms
	for (const sessionId of data.MOCK_SESSION_IDS) {
		appStore.set(sessionDiffFamily(sessionId), [])
	}

	// 4. Reset discovery so useDiscovery() will re-run
	appStore.set(discoveryAtom, {
		loaded: false,
		loading: false,
		error: null,
		phase: "idle",
		projects: [],
	})

	// 5. Reset connection state
	appStore.set(serverUrlAtom, null)
	appStore.set(serverConnectedAtom, false)

	// 6. Reset discovery guard so the real discovery flow can re-run
	resetDiscoveryGuard()
	mockHydrated = false

	log.info("Mock mode deactivated, real discovery will restart")
}
