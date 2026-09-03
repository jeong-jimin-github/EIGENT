import {
	PromptInput,
	PromptInputFooter,
	PromptInputProvider,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	usePromptInputController,
} from "@palot/ui/components/ai-elements/prompt-input"
import { type MentionOption, MentionPopover, type MentionPopoverHandle } from "./chat/mention-popover"
import {
	createAgentMention,
	createFileMention,
	insertMentionIntoText,
} from "./chat/prompt-mentions"
import { Popover, PopoverContent, PopoverTrigger } from "@palot/ui/components/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@palot/ui/components/tooltip"
import { useNavigate, useParams } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import {
	ChevronDownIcon,
	CodeIcon,
	FileTextIcon,
	GitForkIcon,
	GitPullRequestIcon,
	MonitorIcon,
} from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
	projectAgentRuntimesAtom,
	projectModelsAtom,
	setProjectAgentRuntimeAtom,
	setProjectModelAtom,
	setSessionAgentRuntimeAtom,
} from "../atoms/preferences"
import {
	removeSessionAtom,
	setSessionBranchAtom,
	setSessionSetupPhaseAtom,
	setSessionWorktreeAtom,
	upsertSessionAtom,
} from "../atoms/sessions"
import { appStore } from "../atoms/store"
import { useAgents, useProjectList } from "../hooks/use-agents"
import { NEW_CHAT_DRAFT_KEY, useDraftActions, useDraftSnapshot } from "../hooks/use-draft"
import type { ModelRef } from "../hooks/use-opencode-data"
import {
	getModelInputCapabilities,
	getModelVariants,
	resolveEffectiveModel,
	useConfig,
	useModelState,
	useOpenCodeAgents,
	useProviders,
	useVcs,
} from "../hooks/use-opencode-data"
import { useI18n } from "../hooks/use-i18n"
import { useAgentActions } from "../hooks/use-server"
import type { FileAttachment } from "../lib/types"
import {
	fetchAgentProviders,
	type AgentProviderSnapshot,
	type AgentRuntimeSelection,
} from "../services/eigent-agents"
import { sendUnifiedAgentPrompt } from "../services/eigent-chat-adapter"
import { createWorktree, randomWorktreeName } from "../services/worktree-service"
import { useSetAppBarContent } from "./app-bar-context"
import { BranchPicker } from "./branch-picker"
import { PromptAttachmentPreview } from "./chat/prompt-attachments"
import { PromptToolbar, StatusBar } from "./chat/prompt-toolbar"
import { EigentWordmark } from "./eigent-wordmark"

// ============================================================
// Worktree mode toggle
// ============================================================

function WorktreeToggle({
	mode,
	onModeChange,
}: {
	mode: "local" | "worktree"
	onModeChange: (mode: "local" | "worktree") => void
}) {
	const { t } = useI18n()
	return (
		<div className="flex items-center rounded-md border border-border/40">
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							onClick={() => onModeChange("local")}
							className={`flex items-center gap-1 rounded-l-md px-1.5 py-0.5 text-[11px] transition-colors ${
								mode === "local"
									? "bg-muted/80 text-foreground"
									: "text-muted-foreground/60 hover:text-muted-foreground"
							}`}
						/>
					}
				>
					<MonitorIcon className="size-3" />
					<span>{t("newChat.local")}</span>
				</TooltipTrigger>
				<TooltipContent side="top">{t("newChat.localHint")}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							onClick={() => onModeChange("worktree")}
							className={`flex items-center gap-1 rounded-r-md px-1.5 py-0.5 text-[11px] transition-colors ${
								mode === "worktree"
									? "bg-muted/80 text-foreground"
									: "text-muted-foreground/60 hover:text-muted-foreground"
							}`}
						/>
					}
				>
					<GitForkIcon className="size-3" />
					<span>{t("newChat.worktree")}</span>
				</TooltipTrigger>
				<TooltipContent side="top">{t("newChat.worktreeHint")}</TooltipContent>
			</Tooltip>
		</div>
	)
}

// ============================================================
// Mention support helpers (mirrors the pattern in ChatInput)
// ============================================================

/**
 * Exposes the PromptInputProvider's text controller to outside components
 * via a ref — needed to insert mention text without going through React state.
 */
function MentionBridge({
	controllerRef,
}: {
	controllerRef: React.RefObject<{ setText: (text: string) => void; getText: () => string } | null>
}) {
	const controller = usePromptInputController()
	useEffect(() => {
		if (controllerRef && "current" in controllerRef) {
			;(controllerRef as React.MutableRefObject<typeof controllerRef.current>).current = {
				setText: (text: string) => controller.textInput.setInput(text),
				getText: () => controller.textInput.value,
			}
		}
		return () => {
			if (controllerRef && "current" in controllerRef) {
				;(controllerRef as React.MutableRefObject<typeof controllerRef.current>).current = null
			}
		}
	}, [controller, controllerRef])
	return null
}

/**
 * Detects `@` trigger patterns in the prompt textarea and notifies the parent
 * so the MentionPopover can open/close and filter results.
 */
function MentionTrigger({
	onMentionChange,
}: {
	onMentionChange: (open: boolean, query: string) => void
}) {
	const controller = usePromptInputController()
	const inputText = controller.textInput.value
	useEffect(() => {
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea[data-prompt-input]")
		const cursorPos = textarea?.selectionStart ?? inputText.length
		const textBeforeCursor = inputText.slice(0, cursorPos)
		const atMatch = textBeforeCursor.match(/@(\S*)$/)
		if (atMatch) {
			onMentionChange(true, atMatch[1])
			return
		}
		onMentionChange(false, "")
	}, [inputText, onMentionChange])
	return null
}

const NO_PROJECT_SLUG = "no-project"

const SUGGESTIONS = [
	{ icon: CodeIcon, key: "newChat.suggestionFeature" as const },
	{ icon: FileTextIcon, key: "newChat.suggestionArchitecture" as const },
	{ icon: GitPullRequestIcon, key: "newChat.suggestionReview" as const },
]

/**
 * Syncs PromptInputProvider text to persisted drafts (debounced).
 * Must be rendered inside a <PromptInputProvider>.
 */
function DraftSync({ setDraft }: { setDraft: (text: string) => void }) {
	const controller = usePromptInputController()
	const value = controller.textInput.value
	const isFirstRender = useRef(true)

	useEffect(() => {
		if (isFirstRender.current) {
			isFirstRender.current = false
			return
		}
		setDraft(value)
	}, [value, setDraft])

	return null
}

export function NewChat() {
	const { projectSlug } = useParams({ strict: false })
	const projects = useProjectList()
	const { createSession, sendPrompt } = useAgentActions()
	const navigate = useNavigate()
	const { t } = useI18n()

	// Inject app name into the AppBar
	const setAppBarContent = useSetAppBarContent()
	useLayoutEffect(() => {
		setAppBarContent(
			<EigentWordmark className="text-[10px] shrink-0 text-muted-foreground/70" />,
		)
		return () => setAppBarContent(null)
	}, [setAppBarContent])

	const [selectedDirectory, setSelectedDirectory] = useState<string>("")
	const [launching, setLaunching] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [worktreeMode, setWorktreeMode] = useState<"local" | "worktree">("local")

	// Draft persistence — survives page reloads.
	// Non-reactive snapshot: the draft is only used for PromptInputProvider's
	// initialInput (consumed once on mount), so reactive tracking is unnecessary.
	const draft = useDraftSnapshot(NEW_CHAT_DRAFT_KEY)
	const { setDraft, clearDraft } = useDraftActions(NEW_CHAT_DRAFT_KEY)
	const [projectPickerOpen, setProjectPickerOpen] = useState(false)

	// Toolbar state
	const [selectedModel, setSelectedModel] = useState<ModelRef | null>(null)
	const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
	const [selectedVariant, setSelectedVariant] = useState<string | undefined>(undefined)
	const [runtime, setRuntime] = useState<AgentRuntimeSelection>({ provider: "opencode" })
	const [agentProviders, setAgentProviders] = useState<AgentProviderSnapshot[]>([])

	// Mention popover state
	const [mentionOpen, setMentionOpen] = useState(false)
	const [mentionQuery, setMentionQuery] = useState("")
	const controllerRef = useRef<{ setText: (text: string) => void; getText: () => string } | null>(
		null,
	)
	const mentionPopoverRef = useRef<MentionPopoverHandle>(null)

	// Seed selectedModel, selectedVariant, and selectedAgent from the persisted
	// per-project preferences on first mount / project switch.
	// This puts the model at step 1 (user override) in resolveEffectiveModel, so it
	// wins over config.model and global recent list — matching the user's expectation
	// that the model they last used in this project sticks.
	const projectModels = useAtomValue(projectModelsAtom)
	const projectAgentRuntimes = useAtomValue(projectAgentRuntimesAtom)
	const prevDirectoryRef = useRef<string | null>(null)
	const userSelectedProjectRef = useRef(false)

	useEffect(() => {
		const controller = new AbortController()
		fetchAgentProviders(controller.signal)
			.then(setAgentProviders)
			.catch((err) => {
				if (!controller.signal.aborted) console.warn("Failed to load unified agent providers", err)
			})
		return () => controller.abort()
	}, [])
	useEffect(() => {
		if (selectedDirectory === prevDirectoryRef.current) return
		prevDirectoryRef.current = selectedDirectory
		const stored = selectedDirectory ? projectModels[selectedDirectory] : undefined
		if (stored?.providerID && stored?.modelID) {
			setSelectedModel(stored)
			setSelectedVariant(stored.variant)
		} else {
			setSelectedModel(null)
			setSelectedVariant(undefined)
		}
		// Restore the per-project agent preference (null = use config default)
		setSelectedAgent(stored?.agent ?? null)
		setRuntime(
			selectedDirectory
				? projectAgentRuntimes[selectedDirectory] ?? { provider: "opencode" }
				: { provider: "opencode" },
		)
	}, [selectedDirectory, projectModels, projectAgentRuntimes])

	const selectedProject = useMemo(
		() => projects.find((p) => p.directory === selectedDirectory),
		[projects, selectedDirectory],
	)

	const { data: providers } = useProviders(selectedDirectory)
	const { data: config } = useConfig(selectedDirectory)
	const { data: vcs, reload: reloadVcs } = useVcs(selectedDirectory || null)
	const { agents: openCodeAgents } = useOpenCodeAgents(selectedDirectory)
	const { recentModels, addRecent: addRecentModel } = useModelState()

	// Handle model selection — set local state + persist to model.json.
	// Reset variant when the model changes: the new model may have different
	// (or no) variants, so carrying over a stale variant would be incorrect.
	const handleModelSelect = useCallback(
		(model: ModelRef | null) => {
			setSelectedModel(model)
			setSelectedVariant(undefined)
			if (model) addRecentModel(model)
		},
		[addRecentModel],
	)

	const handleRuntimeSelect = useCallback(
		(next: AgentRuntimeSelection) => {
			setRuntime(next)
			if (selectedDirectory) {
				appStore.set(setProjectAgentRuntimeAtom, { directory: selectedDirectory, runtime: next })
			}
		},
		[selectedDirectory],
	)

	// Count active sessions on the selected directory (for branch switch warnings)
	const allAgents = useAgents()
	const activeSessionCount = useMemo(() => {
		if (!selectedDirectory) return 0
		return allAgents.filter(
			(a) =>
				a.directory === selectedDirectory && (a.status === "running" || a.status === "waiting"),
		).length
	}, [allAgents, selectedDirectory])

	// Callback when branch is switched via the BranchPicker — forces VCS reload
	const handleBranchChanged = useCallback(
		(_branch: string) => {
			// VCS hook polls every 30s, but we want immediate UI update.
			// The SSE vcs.branch.updated event will also fire eventually.
			reloadVcs()
		},
		[reloadVcs],
	)

	// Insert a selected mention into the prompt textarea
	const handleMentionSelect = useCallback((option: MentionOption) => {
		setMentionOpen(false)
		const ctrl = controllerRef.current
		if (!ctrl) return
		const currentText = ctrl.getText()
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea[data-prompt-input]")
		const cursorPos = textarea?.selectionStart ?? currentText.length
		const mention =
			option.type === "file" ? createFileMention(option.path) : createAgentMention(option.name)
		const { text: newText, cursorPosition: newCursor } = insertMentionIntoText(
			currentText,
			cursorPos,
			mention,
		)
		ctrl.setText(newText)
		requestAnimationFrame(() => {
			const ta = document.querySelector<HTMLTextAreaElement>("textarea[data-prompt-input]")
			if (ta) {
				ta.focus()
				ta.setSelectionRange(newCursor, newCursor)
			}
		})
	}, [])

	// Delegate keyboard events to the mention popover when it's open
	const handleTextareaKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (mentionPopoverRef.current?.handleKeyDown(e)) return
		},
		[],
	)

	// Resolve active agent for model resolution
	const activeOpenCodeAgent = useMemo(() => {
		const agentName = selectedAgent ?? config?.defaultAgent
		return openCodeAgents?.find((a) => a.name === agentName) ?? null
	}, [selectedAgent, config?.defaultAgent, openCodeAgents])

	// Resolve effective model — selectedModel is seeded from the persisted project model
	// on mount/project switch (above), so it already wins at step 1 of the resolution chain.
	const effectiveModel = useMemo(
		() =>
			resolveEffectiveModel(
				selectedModel,
				activeOpenCodeAgent,
				config?.model,
				providers?.defaults ?? {},
				providers?.providers ?? [],
				recentModels,
			),
		[selectedModel, activeOpenCodeAgent, config?.model, providers, recentModels],
	)

	// Validate variant against the effective model's available variants.
	// Clears the variant if the current model doesn't support it (e.g. restored
	// from per-project preference but the model was changed, or provider updated).
	useEffect(() => {
		if (!selectedVariant || !effectiveModel || !providers) return
		const available = getModelVariants(
			effectiveModel.providerID,
			effectiveModel.modelID,
			providers.providers,
		)
		if (!available.includes(selectedVariant)) {
			setSelectedVariant(undefined)
		}
	}, [selectedVariant, effectiveModel, providers])

	// Model input capabilities (for attachment warnings)
	const modelCapabilities = useMemo(
		() =>
			runtime.provider === "opencode"
				? getModelInputCapabilities(effectiveModel, providers?.providers ?? [])
				: { image: false, pdf: false },
		[effectiveModel, providers, runtime.provider],
	)

	useEffect(() => {
		if (projectSlug === NO_PROJECT_SLUG) {
			userSelectedProjectRef.current = true
			setSelectedDirectory("")
			setWorktreeMode("local")
			return
		}

		if (projectSlug) {
			const match = projects.find((p) => p.slug === projectSlug)
			if (match) {
				setSelectedDirectory(match.directory)
				return
			}
		}

		if (!userSelectedProjectRef.current && projects.length > 0) {
			setSelectedDirectory(projects[0].directory)
		}
	}, [projectSlug, projects])

	// ---
	// Launch helpers
	// ---

	/** Persist the model + variant + agent for this project so new sessions remember it. */
	const persistProjectModel = useCallback(() => {
		if (!effectiveModel || !selectedDirectory) return
		appStore.set(setProjectModelAtom, {
			directory: selectedDirectory,
			model: {
				...effectiveModel,
				variant: selectedVariant,
				agent: selectedAgent ?? undefined,
			},
		})
	}, [effectiveModel, selectedDirectory, selectedVariant, selectedAgent])

	const persistSessionRuntime = useCallback(
		(sessionId: string, agentSessionId?: string) => {
			appStore.set(setSessionAgentRuntimeAtom, {
				sessionId,
				runtime: { ...runtime, agentSessionId },
			})
			if (selectedDirectory) {
				appStore.set(setProjectAgentRuntimeAtom, { directory: selectedDirectory, runtime })
			}
		},
		[runtime, selectedDirectory],
	)

	/** Navigate to the chat view for a given session. */
	const navigateToSession = useCallback(
		(sessionId: string) => {
			const project = projects.find((p) => p.directory === selectedDirectory)
			navigate({
				to: "/project/$projectSlug/session/$sessionId",
				params: {
					projectSlug: project?.slug ?? NO_PROJECT_SLUG,
					sessionId,
				},
			})
		},
		[projects, selectedDirectory, navigate],
	)

	/** Launch a session in local mode (no worktree). */
	const launchLocal = useCallback(
		async (promptText: string, files?: FileAttachment[]) => {
			const session = await createSession(selectedDirectory)
			if (!session) return

			const currentBranch = vcs?.branch ?? ""
			if (currentBranch) {
				appStore.set(setSessionBranchAtom, { sessionId: session.id, branch: currentBranch })
			}

			if (runtime.provider === "opencode") {
				persistProjectModel()
				await sendPrompt(selectedDirectory, session.id, promptText, {
					model: effectiveModel ?? undefined,
					agent: selectedAgent ?? undefined,
					variant: selectedVariant,
					files,
				})
				clearDraft()
				navigateToSession(session.id)
				return
			}

			persistSessionRuntime(session.id)
			clearDraft()
			navigateToSession(session.id)
			await sendUnifiedAgentPrompt({
				uiSessionId: session.id,
				workspace: selectedDirectory,
				runtime,
				message: promptText,
				onAgentSession: (agentSessionId) => persistSessionRuntime(session.id, agentSessionId),
			})
		},
		[
			selectedDirectory,
			createSession,
			sendPrompt,
			effectiveModel,
			selectedAgent,
			selectedVariant,
			clearDraft,
			persistProjectModel,
			persistSessionRuntime,
			runtime,
			navigateToSession,
			vcs,
		],
	)

	/**
	 * Launch a session in worktree mode.
	 *
	 * Creates a stub session immediately and navigates to the chat view so
	 * the user sees progress in the main content area instead of waiting
	 * on the new-chat screen. The actual worktree creation, real session
	 * creation, and prompt sending happen in the background.
	 */
	const launchWorktree = useCallback(
		(promptText: string, files?: FileAttachment[]) => {
			const sessionSlug = randomWorktreeName()

			// Create a stub session so the chat view can render immediately.
			const stubId = crypto.randomUUID()
			const now = Date.now()
			appStore.set(upsertSessionAtom, {
				session: {
					id: stubId,
					slug: sessionSlug,
					projectID: "",
					directory: selectedDirectory,
					title: "Setting up worktree...",
					version: "",
					time: { created: now, updated: now },
				},
				directory: selectedDirectory,
			})
			appStore.set(setSessionSetupPhaseAtom, {
				sessionId: stubId,
				setupPhase: "creating-worktree",
			})

			if (runtime.provider === "opencode") persistProjectModel()
			clearDraft()
			navigateToSession(stubId)

			// Background: create worktree -> create real session -> send prompt.
			// The chat view shows the setup phase while this runs.
			const run = async () => {
				try {
					// Phase 1: Create the worktree
					const result = await createWorktree(selectedDirectory, selectedDirectory, sessionSlug)
					const sdkDirectory = result.worktreeWorkspace

					// Phase 2: Create the real session
					appStore.set(setSessionSetupPhaseAtom, {
						sessionId: stubId,
						setupPhase: "starting-session",
					})
					const session = await createSession(sdkDirectory)
					if (!session) {
						throw new Error("Failed to create session in worktree")
					}

					// Replace the stub with the real session data. Override the
					// directory back to the parent so it groups correctly in the sidebar.
					appStore.set(upsertSessionAtom, {
						session,
						directory: selectedDirectory,
					})
					appStore.set(setSessionWorktreeAtom, {
						sessionId: session.id,
						worktreePath: result.worktreeRoot,
						worktreeBranch: result.branchName,
					})
					appStore.set(setSessionBranchAtom, {
						sessionId: session.id,
						branch: result.branchName,
					})

					// Navigate to the real session, then clean up the stub
					navigateToSession(session.id)
					appStore.set(removeSessionAtom, stubId)

					// Phase 3: Send the prompt using the selected runtime.
					if (runtime.provider === "opencode") {
						await sendPrompt(sdkDirectory, session.id, promptText, {
							model: effectiveModel ?? undefined,
							agent: selectedAgent ?? undefined,
							variant: selectedVariant,
							files,
						})
					} else {
						persistSessionRuntime(session.id)
						await sendUnifiedAgentPrompt({
							uiSessionId: session.id,
							workspace: sdkDirectory,
							runtime,
							message: promptText,
							onAgentSession: (agentSessionId) =>
								persistSessionRuntime(session.id, agentSessionId),
						})
					}
				} catch (err) {
					console.error("Worktree launch failed:", err)
					// Remove the stub and navigate back to new chat
					appStore.set(removeSessionAtom, stubId)
					setError(`Worktree setup failed: ${err instanceof Error ? err.message : "Unknown error"}`)
					navigate({ to: "/" })
				}
			}

			run()
		},
		[
			selectedDirectory,
			createSession,
			sendPrompt,
			effectiveModel,
			selectedAgent,
			selectedVariant,
			clearDraft,
			persistProjectModel,
			persistSessionRuntime,
			runtime,
			navigateToSession,
			navigate,
		],
	)

	const handleLaunch = useCallback(
		async (promptText: string, files?: FileAttachment[]) => {
			if (!promptText) return
			if (runtime.provider !== "opencode" && !runtime.model) {
				setError("Select a model for the unified provider before starting a session.")
				return
			}
			if (runtime.provider !== "opencode" && files?.length) {
				setError("File attachments are not supported by unified providers yet.")
				return
			}
			setLaunching(true)
			setError(null)
			try {
				if (worktreeMode === "worktree" && selectedDirectory) {
					// Worktree mode navigates immediately and runs setup in the background.
					// The launching state is cleared right away since the chat view takes over.
					launchWorktree(promptText, files)
					setLaunching(false)
				} else {
					await launchLocal(promptText, files)
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to create session")
			} finally {
				setLaunching(false)
			}
		},
		[selectedDirectory, runtime, worktreeMode, launchLocal, launchWorktree],
	)

	const runtimeSnapshot =
		runtime.provider === "opencode"
			? undefined
			: agentProviders.find((provider) => provider.kind === runtime.provider)
	const runtimeReady =
		runtime.provider === "opencode" ||
		(!!runtime.model && !!runtimeSnapshot?.status.available && !!runtimeSnapshot.status.authenticated)
	const hasToolbar = !!providers || agentProviders.length > 0

	return (
		<div className="relative flex h-full flex-col">
			{/* Hero area — vertically centered */}
			<div className="flex flex-1 flex-col items-center justify-center px-3 sm:px-6">
				<div className="w-full max-w-4xl space-y-6 sm:space-y-8">
					{/* Wordmark */}
					<div className="flex justify-center">
						<EigentWordmark className="text-base text-foreground" />
					</div>

					{/* "{t("newChat.hero")}" + project name */}
					<div className="text-center">
						<h1 className="text-2xl font-semibold text-foreground">{t("newChat.hero")}</h1>
							<Popover open={projectPickerOpen} onOpenChange={setProjectPickerOpen}>
								<PopoverTrigger
									render={
										<button
											type="button"
											className="mt-1 inline-flex min-h-10 items-center gap-1 rounded-md px-2 text-xl text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground sm:min-h-0 sm:px-0"
										/>
									}
								>
									{selectedDirectory ? selectedProject?.name ?? t("newChat.selectProject") : "No Project"}
									<ChevronDownIcon className="size-4" />
								</PopoverTrigger>
								<PopoverContent className="w-64 p-1" align="center">
									<button
										type="button"
										onClick={() => {
											userSelectedProjectRef.current = true
											setSelectedDirectory("")
											setWorktreeMode("local")
											setProjectPickerOpen(false)
										}}
										className={`flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${
											!selectedDirectory
												? "bg-muted text-foreground"
												: "text-muted-foreground"
										}`}
									>
										<span className="truncate font-medium">No Project</span>
									</button>
									{projects.map((p) => (
										<button
											key={p.directory}
											type="button"
											onClick={() => {
												userSelectedProjectRef.current = true
												setSelectedDirectory(p.directory)
												setProjectPickerOpen(false)
											}}
											className={`flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${
												p.directory === selectedDirectory
													? "bg-muted text-foreground"
													: "text-muted-foreground"
											}`}
										>
											<span className="truncate font-medium">{p.name}</span>
											<span className="ml-auto text-xs text-muted-foreground/60">
												{p.agentCount}
											</span>
										</button>
									))}
								</PopoverContent>
							</Popover>
					</div>

					{/* Suggestion cards — 3 column grid */}
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
						{SUGGESTIONS.map((suggestion) => {
							const Icon = suggestion.icon
							const suggestionText = t(suggestion.key)
							return (
								<button
									key={suggestion.key}
									type="button"
									onClick={() => handleLaunch(suggestionText)}
									disabled={launching || !runtimeReady}
									className="group/card flex flex-col gap-3 rounded-xl border border-border/50 bg-background/40 backdrop-blur-sm p-4 text-left transition-colors hover:border-muted-foreground/30 hover:bg-background/60 disabled:opacity-50"
								>
									<Icon className="size-5 text-muted-foreground transition-colors group-hover/card:text-foreground" />
									<p className="text-sm leading-snug text-muted-foreground transition-colors group-hover/card:text-foreground">
										{suggestionText}
									</p>
								</button>
							)
						})}
					</div>
				</div>
			</div>

			{/* Bottom-pinned input section */}
			<div className="shrink-0 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-0 sm:px-6 sm:pb-5 sm:pt-3">
				<div className="mx-auto w-full max-w-4xl">
					{/* Input card */}
					<PromptInputProvider key={NEW_CHAT_DRAFT_KEY} initialInput={draft}>
						<DraftSync setDraft={setDraft} />
						<MentionBridge controllerRef={controllerRef} />
						<MentionTrigger
							onMentionChange={(open, query) => {
								setMentionOpen(open)
								setMentionQuery(query)
							}}
						/>
						<div className="relative">
							<MentionPopover
								ref={mentionPopoverRef}
								query={mentionQuery}
								open={mentionOpen}
								directory={selectedDirectory || null}
								agents={openCodeAgents ?? []}
								onSelect={handleMentionSelect}
								onClose={() => setMentionOpen(false)}
							/>
						<PromptInput
							className="rounded-xl"
							accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
							multiple
							maxFileSize={10 * 1024 * 1024}
							onSubmit={(message) => {
								if (message.text.trim())
									handleLaunch(
										message.text.trim(),
										message.files.length > 0 ? message.files : undefined,
									)
							}}
						>
							<PromptAttachmentPreview
								supportsImages={modelCapabilities?.image}
								supportsPdf={modelCapabilities?.pdf}
							/>
							<PromptInputTextarea
								data-prompt-input
								placeholder={t("newChat.placeholder")}
								autoFocus
								disabled={launching || !runtimeReady}
								className="min-h-[80px]"
								onKeyDown={handleTextareaKeyDown}
							/>

							{/* Toolbar + explicit submit button. New-chat previously relied only on
							    requestSubmit() from the textarea, which is fragile with IME/browser input. */}
							<PromptInputFooter>
								<PromptInputTools>
									{hasToolbar && (
										<PromptToolbar
											agents={openCodeAgents ?? []}
											selectedAgent={selectedAgent}
											defaultAgent={config?.defaultAgent}
											onSelectAgent={setSelectedAgent}
											providers={providers}
											effectiveModel={effectiveModel}
											hasModelOverride={!!selectedModel}
											onSelectModel={handleModelSelect}
											recentModels={recentModels}
											selectedVariant={selectedVariant}
											onSelectVariant={setSelectedVariant}
											runtime={runtime}
											agentProviders={agentProviders}
											onSelectRuntime={handleRuntimeSelect}
										/>
									)}
								</PromptInputTools>
								<PromptInputSubmit
									className="size-10 sm:size-8"
									disabled={launching || !runtimeReady}
									status={launching ? "submitted" : undefined}
								/>
							</PromptInputFooter>
						</PromptInput>
						</div>
					</PromptInputProvider>

					{/* Status bar — outside the card */}
					{providers && (
						<StatusBar
							vcs={vcs ?? null}
							isConnected={true}
							branchSlot={
								selectedDirectory ? (
									<BranchPicker
										directory={selectedDirectory}
										currentBranch={vcs?.branch}
										onBranchChanged={handleBranchChanged}
										activeSessionCount={activeSessionCount}
									/>
								) : undefined
							}
							extraSlot={
								vcs ? (
									<WorktreeToggle mode={worktreeMode} onModeChange={setWorktreeMode} />
								) : undefined
							}
						/>
					)}

					{/* Error */}
					{error && (
						<div className="mt-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-500">
							{error}
						</div>
					)}

					{!selectedDirectory && (
						<p className="mt-2 text-center text-xs text-muted-foreground">
							No Project mode uses general chat without project or worktree context.
						</p>
					)}
				</div>
			</div>
		</div>
	)
}
