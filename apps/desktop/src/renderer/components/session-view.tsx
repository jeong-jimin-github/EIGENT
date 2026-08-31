/**
 * Reusable session view component.
 *
 * Renders the full chat UI (AgentDetail with ChatView, prompt input, app bar
 * integration, undo/redo, permissions, etc.) for any given sessionId.
 *
 * This is the extracted "controller" logic that was previously inlined in
 * SessionRoute. Both SessionRoute (for route-driven sessions) and
 * AutomationRunDetail (for automation sessions) use this component.
 */

import { useNavigate, useParams } from "@tanstack/react-router"
import { useAtomValue, useSetAtom } from "jotai"
import { useCallback, useEffect, useRef, useState } from "react"
import { agentFamily, sessionNameFamily } from "../atoms/derived/agents"
import {
	projectAgentRuntimesAtom,
	sessionAgentRuntimesAtom,
	setProjectAgentRuntimeAtom,
	setSessionAgentRuntimeAtom,
} from "../atoms/preferences"
import { removeQuestionAtom, upsertSessionAtom } from "../atoms/sessions"
import { appStore } from "../atoms/store"
import { viewedSessionIdAtom } from "../atoms/ui"
import { useSessionRevert } from "../hooks/use-commands"
import type { ModelRef } from "../hooks/use-opencode-data"
import { useConfig, useOpenCodeAgents, useProviders, useVcs } from "../hooks/use-opencode-data"
import { useAgentActions } from "../hooks/use-server"
import { useSessionChat } from "../hooks/use-session-chat"
import { createLogger } from "../lib/logger"
import type { Agent, FileAttachment, QuestionAnswer } from "../lib/types"
import { fetchSessionById } from "../services/connection-manager"
import {
	fetchAgentProviders,
	type AgentProviderSnapshot,
	type AgentRuntimeSelection,
} from "../services/eigent-agents"
import {
	followUnifiedAgentHistory,
	hydrateUnifiedAgentHistory,
	interruptUnifiedAgentPrompt,
	isUnifiedAgentPromptActive,
	sendUnifiedAgentPrompt,
} from "../services/eigent-chat-adapter"
import { AgentDetail } from "./agent-detail"

const log = createLogger("session-view")

interface SessionViewProps {
	/** The OpenCode session ID to display */
	sessionId: string
}

export function SessionView({ sessionId }: SessionViewProps) {
	const navigate = useNavigate()
	const { projectSlug } = useParams({ strict: false }) as { projectSlug?: string }
	const {
		abort,
		sendPrompt,
		renameSession,
		respondToPermission,
		replyToQuestion,
		rejectQuestion,
		forkSession,
		deletePart,
	} = useAgentActions()

	// Track which session is currently viewed so background sessions can
	// skip expensive metric recomputation.
	const setViewedSessionId = useSetAtom(viewedSessionIdAtom)
	useEffect(() => {
		setViewedSessionId(sessionId)
		return () => setViewedSessionId(null)
	}, [sessionId, setViewedSessionId])

	const selectedAgent = useAtomValue(agentFamily(sessionId))
	const sessionAgentRuntimes = useAtomValue(sessionAgentRuntimesAtom)
	const projectAgentRuntimes = useAtomValue(projectAgentRuntimesAtom)
	const [agentProviders, setAgentProviders] = useState<AgentProviderSnapshot[]>([])

	// Legacy/global OpenCode sessions can retain a directory such as /home/ubuntu.
	// Once discovery classifies them as No Project, repair stale URLs so tools and
	// preview always use the canonical permanent No Project project.
	useEffect(() => {
		if (!selectedAgent || !projectSlug || projectSlug === selectedAgent.projectSlug) return
		void navigate({
			to: "/project/$projectSlug/session/$sessionId",
			params: { projectSlug: selectedAgent.projectSlug, sessionId },
			replace: true,
		})
	}, [navigate, projectSlug, selectedAgent, sessionId])

	const hydratedUnifiedSessionsRef = useRef(new Set<string>())
	const locallyCreatedUnifiedSessionsRef = useRef(new Set<string>())

	useEffect(() => {
		const controller = new AbortController()
		fetchAgentProviders(controller.signal)
			.then(setAgentProviders)
			.catch((err) => {
				if (!controller.signal.aborted) log.warn("Failed to load unified agent providers", err)
			})
		return () => controller.abort()
	}, [])

	// ── Fallback session fetch ──────────────────────────────────────────────
	// Subagent sessions are excluded from the initial batch load (roots:true)
	// and may also be missed if the SSE stream was reconnecting when the server
	// emitted session.created. If the session isn't in the Jotai store yet,
	// attempt a direct GET via the server's session.get endpoint so the user
	// isn't shown a dead "not found" screen.
	//
	// `resolving` stays true until either: (a) the agent is already in the
	// store (fast-path), (b) the fallback fetch succeeds and seeds the store,
	// or (c) the fetch fails / returns null (genuine not-found).
	const [resolving, setResolving] = useState(!selectedAgent)

	useEffect(() => {
		// Fast-path: session is already in the Jotai store.
		if (selectedAgent) {
			setResolving(false)
			return
		}

		// The session isn't in the store — attempt a server-side fetch.
		let cancelled = false
		setResolving(true)

		fetchSessionById(sessionId)
			.then((session) => {
				if (cancelled) return
				if (session) {
					// Seed into the Jotai store. agentFamily will derive an Agent from
					// this entry, causing selectedAgent to become non-null on the next
					// render, which in turn hits the fast-path above.
					appStore.set(upsertSessionAtom, {
						session,
						// Preserve the session's real read scope even when the orphan is grouped under No Project.
						directory: session.directory ?? "",
					})
				} else {
					// Confirmed not found — stop resolving so "not found" renders.
					setResolving(false)
				}
			})
			.catch(() => {
				if (cancelled) return
				setResolving(false)
			})

		return () => {
			cancelled = true
		}
	}, [sessionId, projectSlug]) // Route scope matters for No Project session restoration.

	// Resolve parent session name for breadcrumb navigation
	const parentSessionName = useAtomValue(sessionNameFamily(selectedAgent?.parentId ?? ""))

	// Load chat turns for the selected session
	const isSessionActive = selectedAgent?.status === "running" || selectedAgent?.status === "waiting"
	const {
		turns: chatTurns,
		loading: chatLoading,
		loadingEarlier: chatLoadingEarlier,
		hasEarlierMessages: chatHasEarlier,
		loadEarlier: chatLoadEarlier,
	} = useSessionChat(
		selectedAgent?.directory ?? null,
		selectedAgent?.sessionId ?? null,
		isSessionActive,
	)

	// Undo/redo for this session
	const { canUndo, canRedo, undo, redo, isReverted, revertToMessage } = useSessionRevert(
		selectedAgent?.directory ?? null,
		selectedAgent?.sessionId ?? null,
	)

	// Toolbar data -- providers, config, VCS, and OpenCode agents
	const directory = selectedAgent?.directory ?? null
	const runtime: AgentRuntimeSelection =
		sessionAgentRuntimes[sessionId] ??
		(directory ? projectAgentRuntimes[directory] : undefined) ??
		{ provider: "opencode" }
	const { data: providers } = useProviders(directory)
	const { data: config } = useConfig(directory)
	const { data: vcs } = useVcs(directory)
	const { agents: openCodeAgents } = useOpenCodeAgents(directory)

	// Restore provider-independent chat turns from the durable normalized event log after reload.
	// Sessions created in this renderer are already projected live and must not be replayed again.
	useEffect(() => {
		const persisted = sessionAgentRuntimes[sessionId]
		const agentSessionId = persisted?.agentSessionId
		if (
			!selectedAgent ||
			!agentSessionId ||
			persisted.provider === "opencode" ||
			!persisted.model ||
			locallyCreatedUnifiedSessionsRef.current.has(agentSessionId) ||
			isUnifiedAgentPromptActive(sessionId, agentSessionId)
		) {
			return
		}
		const key = `${sessionId}:${agentSessionId}`
		if (hydratedUnifiedSessionsRef.current.has(key)) return
		hydratedUnifiedSessionsRef.current.add(key)

		const controller = new AbortController()
		void (async () => {
			const restored = await hydrateUnifiedAgentHistory({
				uiSessionId: sessionId,
				workspace: selectedAgent.workspaceDirectory,
				runtime: persisted,
				agentSessionId,
				signal: controller.signal,
			})
			if (
				!controller.signal.aborted &&
				(restored.state === "starting" || restored.state === "running")
			) {
				await followUnifiedAgentHistory({
					uiSessionId: sessionId,
					workspace: selectedAgent.workspaceDirectory,
					runtime: persisted,
					agentSessionId,
					afterSequence: restored.lastSequence,
					signal: controller.signal,
				})
			}
		})().catch((err) => {
			if (!controller.signal.aborted) {
				hydratedUnifiedSessionsRef.current.delete(key)
				log.warn("Failed to restore unified agent history", err)
			}
		})

		return () => controller.abort()
	}, [sessionId, selectedAgent, sessionAgentRuntimes])

	// Handlers
	const persistRuntime = useCallback(
		(next: AgentRuntimeSelection, agentSessionId?: string) => {
			appStore.set(setSessionAgentRuntimeAtom, {
				sessionId,
				runtime: { ...next, agentSessionId },
			})
			if (directory) {
				appStore.set(setProjectAgentRuntimeAtom, { directory, runtime: next })
			}
		},
		[sessionId, directory],
	)

	const handleSelectRuntime = useCallback(
		(next: AgentRuntimeSelection) => {
			const previous = appStore.get(sessionAgentRuntimesAtom)[sessionId]
			const keepSession =
				previous?.provider === next.provider && previous?.model === next.model
					? previous.agentSessionId
					: undefined
			persistRuntime(next, keepSession)
		},
		[sessionId, persistRuntime],
	)

	const sendWithCurrentRuntime = useCallback(
		async (agent: Agent, message: string) => {
			const persisted = appStore.get(sessionAgentRuntimesAtom)[sessionId]
			const currentRuntime = persisted ?? runtime
			if (currentRuntime.provider === "opencode") return false
			await sendUnifiedAgentPrompt({
				uiSessionId: sessionId,
				workspace: agent.workspaceDirectory,
				runtime: currentRuntime,
				message,
				agentSessionId: persisted?.agentSessionId,
				onAgentSession: (agentSessionId) => {
					locallyCreatedUnifiedSessionsRef.current.add(agentSessionId)
					persistRuntime(currentRuntime, agentSessionId)
				},
			})
			return true
		},
		[sessionId, runtime, persistRuntime],
	)

	const handleStopAgent = useCallback(
		async (agent: Agent) => {
			const currentRuntime = appStore.get(sessionAgentRuntimesAtom)[sessionId] ?? runtime
			if (currentRuntime.provider !== "opencode") {
				await interruptUnifiedAgentPrompt(sessionId, currentRuntime.agentSessionId)
				return
			}
			await abort(agent.directory, agent.sessionId)
		},
		[abort, sessionId, runtime],
	)

	const handleApprovePermission = useCallback(
		async (
			agent: Agent,
			permissionSessionId: string,
			permissionId: string,
			response?: "once" | "always",
		) => {
			// Use permissionSessionId (not agent.sessionId) so sub-agent permissions route correctly.
			await respondToPermission(
				agent.directory,
				permissionSessionId,
				permissionId,
				response ?? "once",
			)
		},
		[respondToPermission],
	)

	const handleDenyPermission = useCallback(
		async (agent: Agent, permissionSessionId: string, permissionId: string) => {
			await respondToPermission(agent.directory, permissionSessionId, permissionId, "reject")
		},
		[respondToPermission],
	)

	const handleReplyQuestion = useCallback(
		async (agent: Agent, requestId: string, answers: QuestionAnswer[]) => {
			const currentRuntime = appStore.get(sessionAgentRuntimesAtom)[sessionId] ?? runtime
			if (currentRuntime.provider !== "opencode") {
				appStore.set(removeQuestionAtom, { sessionId, requestId })
				const answer = answers.flat().join("\n").trim()
				if (answer) await sendWithCurrentRuntime(agent, answer)
				return
			}
			await replyToQuestion(agent.directory, requestId, answers)
		},
		[replyToQuestion, sessionId, runtime, sendWithCurrentRuntime],
	)

	const handleRejectQuestion = useCallback(
		async (agent: Agent, requestId: string) => {
			const currentRuntime = appStore.get(sessionAgentRuntimesAtom)[sessionId] ?? runtime
			if (currentRuntime.provider !== "opencode") {
				appStore.set(removeQuestionAtom, { sessionId, requestId })
				await interruptUnifiedAgentPrompt(sessionId, currentRuntime.agentSessionId)
				return
			}
			await rejectQuestion(agent.directory, requestId)
		},
		[rejectQuestion, sessionId, runtime],
	)

	const handleRenameSession = useCallback(
		async (agent: Agent, title: string) => {
			await renameSession(agent.directory, agent.sessionId, title)
		},
		[renameSession],
	)

	const handleForkFromTurn = useCallback(
		async (messageId?: string) => {
			if (!selectedAgent) return
			try {
				const forked = await forkSession(selectedAgent.directory, selectedAgent.sessionId, messageId)
				if (forked && projectSlug) {
					navigate({
						to: "/project/$projectSlug/session/$sessionId",
						params: { projectSlug, sessionId: forked.id },
					})
				}
			} catch (err) {
				log.error("Fork failed", { sessionId: selectedAgent.sessionId, messageId }, err)
			}
		},
		[selectedAgent, forkSession, projectSlug, navigate],
	)

	const handleDeletePart = useCallback(
		async (sessionId: string, messageId: string, partId: string) => {
			if (!selectedAgent) return
			await deletePart(selectedAgent.directory, sessionId, messageId, partId)
		},
		[selectedAgent, deletePart],
	)

	const handleSendMessage = useCallback(
		async (
			agent: Agent,
			message: string,
			options?: {
				model?: ModelRef
				agentName?: string
				variant?: string
				files?: FileAttachment[]
			},
		) => {
			log.debug("handleSendMessage", {
				sessionId: agent.sessionId,
				directory: agent.directory,
				messageLength: message.length,
				model: options?.model,
				agentName: options?.agentName,
				variant: options?.variant,
			})
			try {
				if (await sendWithCurrentRuntime(agent, message)) {
					log.debug("handleSendMessage completed via unified runtime", {
						sessionId: agent.sessionId,
					})
					return
				}
				await sendPrompt(agent.workspaceDirectory, agent.sessionId, message, {
					model: options?.model,
					agent: options?.agentName || undefined,
					variant: options?.variant,
					files: options?.files,
				})
				log.debug("handleSendMessage completed", { sessionId: agent.sessionId })
			} catch (err) {
				log.error("handleSendMessage failed", { sessionId: agent.sessionId }, err)
				throw err
			}
		},
		[sendPrompt, sendWithCurrentRuntime],
	)

	// Session not yet resolved — show spinner while the fallback fetch runs
	if (!selectedAgent && resolving) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="size-4 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-muted-foreground/60" />
			</div>
		)
	}

	// Fallback fetch complete but session genuinely not found
	if (!selectedAgent) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="text-center">
					<p className="text-sm font-medium text-muted-foreground">Session not found</p>
					<p className="mt-1 text-xs text-muted-foreground/60">
						This session may have been deleted or is not yet loaded
					</p>
				</div>
			</div>
		)
	}

	return (
		<AgentDetail
			agent={selectedAgent}
			chatTurns={chatTurns}
			chatLoading={chatLoading}
			chatLoadingEarlier={chatLoadingEarlier}
			chatHasEarlier={chatHasEarlier}
			onLoadEarlier={chatLoadEarlier}
			onStop={handleStopAgent}
			onApprove={handleApprovePermission}
			onDeny={handleDenyPermission}
			onReplyQuestion={handleReplyQuestion}
			onRejectQuestion={handleRejectQuestion}
			onSendMessage={handleSendMessage}
			onRename={handleRenameSession}
			parentSessionName={parentSessionName}
			isConnected={true}
			providers={providers}
			config={config}
			vcs={vcs}
			openCodeAgents={openCodeAgents}
			runtime={runtime}
			agentProviders={agentProviders}
			onSelectRuntime={handleSelectRuntime}
			canUndo={runtime.provider === "opencode" && canUndo}
			canRedo={runtime.provider === "opencode" && canRedo}
			onUndo={runtime.provider === "opencode" ? undo : undefined}
			onRedo={runtime.provider === "opencode" ? redo : undefined}
			isReverted={runtime.provider === "opencode" && isReverted}
			onRevertToMessage={runtime.provider === "opencode" ? revertToMessage : undefined}
			onForkFromTurn={runtime.provider === "opencode" ? handleForkFromTurn : undefined}
			onDeletePart={runtime.provider === "opencode" ? handleDeletePart : undefined}
		/>
	)
}
