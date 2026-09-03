/**
 * Root layout: shared providers, global hooks, keyboard navigation,
 * command palette, and onboarding.
 * Does NOT render any sidebar chrome -- that lives in SidebarLayout.
 */
import { TooltipProvider } from "@palot/ui/components/tooltip"
import { Outlet, useNavigate, useParams } from "@tanstack/react-router"
import { useAtomValue, useSetAtom } from "jotai"
import { lazy, Suspense, useCallback, useEffect, useMemo } from "react"
import { discoveryPhaseAtom } from "../atoms/discovery"
import { onboardingStateAtom } from "../atoms/onboarding"
import { useAgents, useCommandPaletteOpen, useSetCommandPaletteOpen } from "../hooks/use-agents"
import { useChromeTier } from "../hooks/use-chrome-tier"
import { useDiscovery } from "../hooks/use-discovery"
import { useMockMode } from "../hooks/use-mock-mode"
import { useNotifications } from "../hooks/use-notifications"
import { useAgentActions, useServerConnection } from "../hooks/use-server"
import { useServerSettingsSync } from "../hooks/use-servers"
import { useSystemAccentColor } from "../hooks/use-system-accent-color"
import { useThemeEffect } from "../hooks/use-theme"
import { useWaitingIndicator } from "../hooks/use-waiting-indicator"
import { AppBarProvider } from "./app-bar-context"
import { SidebarSlotProvider } from "./sidebar-slot-context"
import { isStartupContentVisible } from "../services/startup-display"
import { StartupOverlay } from "./startup-overlay"

const CommandPalette = lazy(() =>
	import("./command-palette").then((module) => ({ default: module.CommandPalette })),
)
const OnboardingOverlay = lazy(() =>
	import("./onboarding/onboarding-overlay").then((module) => ({ default: module.OnboardingOverlay })),
)

export function RootLayout() {
	const isMockMode = useMockMode()
	const onboardingState = useAtomValue(onboardingStateAtom)
	const setOnboardingState = useSetAtom(onboardingStateAtom)

	// Only run discovery/connection after onboarding is complete (or in browser mode / mock mode)
	const isElectronEnv = typeof window !== "undefined" && "palot" in window
	const showOnboarding = isElectronEnv && !onboardingState.completed && !isMockMode

	// Track discovery phase to coordinate startup overlay / content crossfade
	const phase = useAtomValue(discoveryPhaseAtom)

	useServerSettingsSync()
	useDiscovery()
	useServerConnection()
	useWaitingIndicator()
	useThemeEffect()
	useChromeTier()
	useSystemAccentColor()

	const agents = useAgents()
	const { forkSession } = useAgentActions()
	const commandPaletteOpen = useCommandPaletteOpen()
	const setCommandPaletteOpen = useSetCommandPaletteOpen()
	const navigate = useNavigate()
	const params = useParams({ strict: false })
	const sessionId = (params as Record<string, string | undefined>).sessionId

	// Native OS notifications: badge sync, click-to-navigate, auto-dismiss
	useNotifications(navigate, sessionId)

	// ========== Command palette: fork session ==========

	const activeAgent = useMemo(
		() => (sessionId ? (agents.find((a) => a.id === sessionId) ?? null) : null),
		[agents, sessionId],
	)

	const handleForkSession = useCallback(async () => {
		if (!activeAgent) return
		const forked = await forkSession(activeAgent.directory, activeAgent.id)
		navigate({
			to: "/project/$projectSlug/session/$sessionId",
			params: { projectSlug: activeAgent.projectSlug, sessionId: forked.id },
		})
	}, [activeAgent, forkSession, navigate])

	// Sub-agents are filtered at the API level (roots: true), so all agents here are root agents
	const visibleAgents = agents

	// ========== Keyboard navigation ==========

	const handleKeyDown = useCallback(
		(e: KeyboardEvent) => {
			const target = e.target as HTMLElement
			if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
				return
			}

			if (e.key === "Escape") {
				e.preventDefault()
				navigate({ to: "/" })
				return
			}

			if ((e.key === "j" || e.key === "k") && !e.metaKey && !e.ctrlKey && !e.altKey) {
				e.preventDefault()
				const currentIndex = visibleAgents.findIndex((a) => a.id === sessionId)
				let nextIndex: number
				if (e.key === "j") {
					nextIndex = currentIndex < visibleAgents.length - 1 ? currentIndex + 1 : 0
				} else {
					nextIndex = currentIndex > 0 ? currentIndex - 1 : visibleAgents.length - 1
				}
				const agent = visibleAgents[nextIndex]
				if (agent) {
					navigate({
						to: "/project/$projectSlug/session/$sessionId",
						params: {
							projectSlug: agent.projectSlug,
							sessionId: agent.id,
						},
					})
				}
				return
			}

			if ((e.metaKey || e.ctrlKey) && e.key === "n") {
				e.preventDefault()
				navigate({ to: "/" })
				return
			}

			if ((e.metaKey || e.ctrlKey) && e.key === "k") {
				e.preventDefault()
				setCommandPaletteOpen(true)
				return
			}
		},
		[sessionId, visibleAgents, navigate, setCommandPaletteOpen],
	)

	useEffect(() => {
		document.addEventListener("keydown", handleKeyDown)
		return () => document.removeEventListener("keydown", handleKeyDown)
	}, [handleKeyDown])

	// ========== Onboarding completion ==========

	const handleOnboardingComplete = useCallback(
		(state: {
			skippedSteps: string[]
			migrationPerformed: boolean
			migratedFrom: string[]
			opencodeVersion: string | null
			providersConnected: number
		}) => {
			setOnboardingState({
				completed: true,
				completedAt: new Date().toISOString(),
				skippedSteps: state.skippedSteps,
				migrationPerformed: state.migrationPerformed,
				migratedFrom: state.migratedFrom,
				opencodeVersion: state.opencodeVersion,
				providersConnected: state.providersConnected,
			})
		},
		[setOnboardingState],
	)


	// ========== Layout ==========

	if (showOnboarding) {
		return (
			<Suspense fallback={null}>
				<OnboardingOverlay onComplete={handleOnboardingComplete} />
			</Suspense>
		)
	}

	// Hide app content while the startup overlay is covering the screen.
	// The overlay fades out at "ready"; showing content at "ready" creates a
	// smooth crossfade. Content is still rendered (just invisible) so React
	// can paint it before the overlay lifts.
	const contentReady = isStartupContentVisible(phase)

	return (
		<TooltipProvider>
			<AppBarProvider>
				<SidebarSlotProvider>
					<div
						className={`transition-opacity duration-300 ${contentReady ? "opacity-100" : "opacity-0"}`}
					>
						<Outlet />
						{commandPaletteOpen ? (
							<Suspense fallback={null}>
								<CommandPalette
									open
									onOpenChange={setCommandPaletteOpen}
									agents={agents}
									onForkSession={activeAgent ? handleForkSession : undefined}
								/>
							</Suspense>
						) : null}
					</div>
					<StartupOverlay />
				</SidebarSlotProvider>
			</AppBarProvider>
		</TooltipProvider>
	)
}
