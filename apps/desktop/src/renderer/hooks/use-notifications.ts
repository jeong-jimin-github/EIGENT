import { useAtomValue } from "jotai"
import { useCallback, useEffect, useState } from "react"
import { agentFamily, agentsAtom } from "../atoms/derived/agents"
import { pendingCountAtom } from "../atoms/derived/waiting"
import { sessionAgentRuntimesAtom } from "../atoms/preferences"
import { appStore } from "../atoms/store"

const isElectron = typeof window !== "undefined" && "palot" in window

interface NotificationTarget {
	sessionId?: string
	uiSessionId?: string
}

function initialWebTarget(): NotificationTarget | null {
	if (typeof window === "undefined" || isElectron) return null
	const params = new URLSearchParams(window.location.search)
	const sessionId = params.get("eigentSession") ?? undefined
	const uiSessionId = params.get("uiSession") ?? undefined
	return sessionId || uiSessionId ? { sessionId, uiSessionId } : null
}

/**
 * Handles native Electron notifications and PWA Web Push notification navigation.
 */
export function useNotifications(
	navigate: (opts: { to: string; params: Record<string, string> }) => void,
	currentSessionId: string | undefined,
) {
	const pendingCount = useAtomValue(pendingCountAtom)
	const agents = useAtomValue(agentsAtom)
	const runtimes = useAtomValue(sessionAgentRuntimesAtom)
	const [webTarget, setWebTarget] = useState<NotificationTarget | null>(initialWebTarget)

	useEffect(() => {
		if (!isElectron) return
		window.palot.updateBadgeCount(pendingCount)
	}, [pendingCount])

	const navigateToSession = useCallback(
		(sessionId: string) => {
			const agent = appStore.get(agentFamily(sessionId))
			if (!agent) return false
			navigate({
				to: "/project/$projectSlug/session/$sessionId",
				params: { projectSlug: agent.projectSlug, sessionId: agent.id },
			})
			return true
		},
		[navigate],
	)

	useEffect(() => {
		if (!isElectron) return
		return window.palot.onNotificationNavigate((data) => {
			navigateToSession(data.sessionId)
		})
	}, [navigateToSession])

	useEffect(() => {
		if (isElectron || !("serviceWorker" in navigator)) return
		const onMessage = (event: MessageEvent) => {
			if (event.data?.type !== "eigent:notification-click") return
			setWebTarget({
				sessionId: typeof event.data.sessionId === "string" ? event.data.sessionId : undefined,
				uiSessionId: typeof event.data.uiSessionId === "string" ? event.data.uiSessionId : undefined,
			})
		}
		navigator.serviceWorker.addEventListener("message", onMessage)
		return () => navigator.serviceWorker.removeEventListener("message", onMessage)
	}, [])

	useEffect(() => {
		if (isElectron || !webTarget) return
		let target = webTarget.uiSessionId
		if (!target && webTarget.sessionId) {
			for (const [uiSessionId, runtime] of Object.entries(runtimes)) {
				if (
					runtime.agentSessionId === webTarget.sessionId ||
					Object.values(runtime.agentSessionIds ?? {}).includes(webTarget.sessionId)
				) {
					target = uiSessionId
					break
				}
			}
		}
		if (!target) return
		if (!navigateToSession(target)) return

		const url = new URL(window.location.href)
		url.searchParams.delete("eigentSession")
		url.searchParams.delete("uiSession")
		window.history.replaceState(window.history.state, "", url)
		setWebTarget(null)
	}, [webTarget, runtimes, agents, navigateToSession])

	useEffect(() => {
		if (!isElectron || !currentSessionId) return
		window.palot.dismissNotification(currentSessionId)
	}, [currentSessionId])
}
