import { useAtomValue } from "jotai"
import { useEffect } from "react"
import { activeServerConfigAtom, serverConnectedAtom } from "../atoms/connection"
import { discoveryAtom } from "../atoms/discovery"
import { isMockModeAtom } from "../atoms/mock-mode"
import { appStore } from "../atoms/store"
import { createLogger } from "../lib/logger"
import { resolveAuthHeader, resolveServerUrl } from "../services/backend"
import {
	connectToOpenCode,
	loadAllProjects,
	loadProjectSessions,
} from "../services/connection-manager"

const log = createLogger("discovery")

const INITIAL_SERVER_RECOVERY_TIMEOUT_MS = 120_000
const SERVER_RECOVERY_POLL_MS = 500

/**
 * The server process can be reachable before the child OpenCode process is ready,
 * especially on low-memory remote hosts. connectToOpenCode() starts its own health/SSE
 * recovery loop, so discovery should wait for that loop instead of permanently
 * classifying the server offline after the very first probe.
 */
async function waitForInitialServerRecovery(): Promise<boolean> {
	if (appStore.get(serverConnectedAtom)) return true
	const deadline = Date.now() + INITIAL_SERVER_RECOVERY_TIMEOUT_MS
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, SERVER_RECOVERY_POLL_MS))
		if (appStore.get(serverConnectedAtom)) return true
	}
	return appStore.get(serverConnectedAtom)
}

// Module-level guard to prevent concurrent discovery runs.
// The Jotai atom guard (loaded/loading) depends on a React re-render
// to propagate, which can race with React Strict Mode double-effects
// or fast re-mounts.
let discoveryInFlight = false

/** Reset the discovery guard so discovery can re-run (used when switching servers or exiting mock mode). */
export function resetDiscoveryGuard(): void {
	discoveryInFlight = false
}

/** Helper to update the discovery phase without touching other fields. */
function setPhase(phase: import("../atoms/discovery").DiscoveryPhase): void {
	appStore.set(discoveryAtom, (prev) => ({ ...prev, phase }))
}

/**
 * API-first discovery hook.
 *
 * On mount:
 * 1. Resolves the active server URL (spawns local or uses remote URL)
 * 2. Resolves auth credentials if the server requires them
 * 3. Connects to the OpenCode server (SSE events for all projects)
 * 4. Lists all projects from the API via `client.project.list()`
 * 5. Loads sessions for the top few most-recently-active projects
 *    (enough to populate "Recent" and "Active Now" sections)
 *
 * Remaining project sessions are loaded lazily when expanded in the sidebar.
 * Active sessions also arrive in real-time via SSE events.
 */
export function useDiscovery() {
	const discovery = useAtomValue(discoveryAtom)
	const isMockMode = useAtomValue(isMockModeAtom)
	const activeServer = useAtomValue(activeServerConfigAtom)
	const serverConnected = useAtomValue(serverConnectedAtom)
	const { loaded, loading, error } = discovery

	useEffect(() => {
		// In mock mode, atoms are hydrated by useMockMode() -- skip real discovery
		if (isMockMode) return

		// A slow or warming remote server can fail the first health probe while the
		// connection manager keeps retrying in the background. Once that loop marks
		// the server connected, release the offline discovery guard and continue
		// without requiring a manual refresh or server switch.
		if (discoveryInFlight && serverConnected && error === "Server offline") {
			discoveryInFlight = false
		}

		if (loaded || loading || discoveryInFlight) return
		discoveryInFlight = true

		// Set loading
		appStore.set(discoveryAtom, (prev) => ({
			...prev,
			loading: true,
			error: null,
			phase: "starting-server",
		}))

		;(async () => {
			try {
				// --- Step 1: Resolve the server URL ---
				log.info("Resolving server URL...", {
					server: activeServer.name,
					type: activeServer.type,
				})
				const url = await resolveServerUrl(activeServer)

				// --- Step 2: Resolve auth if needed ---
				const authHeader = await resolveAuthHeader(activeServer)

				// --- Step 3: Connect to the server (starts SSE event loop) ---
				setPhase("connecting")
				log.info("Connecting to OpenCode server", {
					url,
					server: activeServer.name,
					authenticated: !!authHeader,
				})
				await connectToOpenCode(url, authHeader)

				// --- Step 3b: Allow a warming remote OpenCode process to recover ---
				// The outer EIGENT server may already be up while OpenCode is still starting.
				// connectToOpenCode() starts a background health/SSE retry loop; wait for it
				// for a bounded period instead of freezing discovery in "Server offline".
				if (!appStore.get(serverConnectedAtom)) {
					setPhase("connecting")
					log.info("Initial health probe failed; waiting for server recovery", {
						server: activeServer.name,
						timeoutMs: INITIAL_SERVER_RECOVERY_TIMEOUT_MS,
					})
					const recovered = await waitForInitialServerRecovery()
					if (!recovered) {
						log.warn("Server did not recover before discovery timeout", {
							server: activeServer.name,
						})
						discoveryInFlight = false
						appStore.set(discoveryAtom, (prev) => ({
							...prev,
							loading: false,
							error: "Server offline",
							phase: "error",
						}))
						return
					}
					log.info("Server recovered during discovery warmup", { server: activeServer.name })
				}

				// --- Step 4: Discover projects from the API ---
				setPhase("loading-projects")
				log.info("Loading projects from API...")
				const projects = await loadAllProjects()
				log.info("Discovered projects via API", { count: projects.length })

				// Store projects and mark discovery as complete.
				// Remaining sessions are loaded lazily when the user expands a project.
				appStore.set(discoveryAtom, {
					loaded: true,
					loading: false,
					error: null,
					phase: "ready",
					projects,
				})

				// --- Step 5: Pre-fetch sessions for the most recent projects ---
				// Load sessions from the top N most-recently-active projects so the
				// "Recent" and "Active Now" sidebar sections are populated at boot.
				// This replaces the previous approach of loading ALL projects (80+ calls)
				// with just a few calls for the projects the user likely cares about.
				const PREFETCH_COUNT = 3
				const sortedByActivity = [...projects]
					.filter((p) => p.worktree)
					.sort((a, b) => (b.time.updated ?? 0) - (a.time.updated ?? 0))
					.slice(0, PREFETCH_COUNT)

				if (sortedByActivity.length > 0) {
					// Build sandbox lookup for worktree metadata restoration
					const projectSandboxMap = new Map<string, Set<string>>()
					for (const project of projects) {
						if (!project.worktree || !project.sandboxes?.length) continue
						const sandboxSet = new Set<string>()
						for (const s of project.sandboxes) sandboxSet.add(s)
						projectSandboxMap.set(project.worktree, sandboxSet)
					}

					await Promise.allSettled(
						sortedByActivity.map((project) => {
							const sandboxDirs = projectSandboxMap.get(project.worktree!)
							return loadProjectSessions(
								project.worktree!,
								sandboxDirs?.size ? sandboxDirs : undefined,
								{ limit: 5, roots: true },
							)
						}),
					)
				}

				log.info("Discovery complete", {
					server: activeServer.name,
					url,
					projects: projects.length,
					prefetched: sortedByActivity.length,
				})
			} catch (err) {
				log.error("Discovery failed", err)
				discoveryInFlight = false
				appStore.set(discoveryAtom, (prev) => ({
					...prev,
					loading: false,
					error: err instanceof Error ? err.message : "Discovery failed",
					phase: "error",
				}))
			}
		})()
	}, [loaded, loading, error, isMockMode, activeServer, serverConnected])
}
