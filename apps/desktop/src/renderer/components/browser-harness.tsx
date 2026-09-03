import { Button } from "@palot/ui/components/button"
import { Globe2Icon, MonitorSmartphoneIcon, PanelRightCloseIcon } from "lucide-react"
import { useAtom, useAtomValue } from "jotai"
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react"
import { activePreviewContextAtom, rightPanelWidthPercentAtom, sessionDiffFamily } from "../atoms/ui"
import {
	findWorkspacePreviewEntry,
	hasWebPreviewChanges,
	isLoopbackPreviewUrl,
	webPreviewChangedFiles,
	webPreviewRevision,
} from "../services/device-preview"
const BrowserLiveView = lazy(() =>
	import("./browser-live-view").then((module) => ({ default: module.BrowserLiveView })),
)
const DevicePreviewView = lazy(() =>
	import("./device-preview-view").then((module) => ({ default: module.DevicePreviewView })),
)
const LoopbackDevicePreviewView = lazy(() =>
	import("./loopback-device-preview-view").then((module) => ({
		default: module.LoopbackDevicePreviewView,
	})),
)

interface BrowserStatus {
	connected: boolean
	tabs?: Array<{ id: string; url: string; title: string }>
}

type PreviewMode = "device" | "cloud"

export function BrowserHarness() {
	const previewContext = useAtomValue(activePreviewContextAtom)
	const sessionDiffs = useAtomValue(
		sessionDiffFamily(previewContext?.sessionId ?? "__eigent-no-preview-session__"),
	)
	const hasWorkspaceWebChanges = Boolean(previewContext && hasWebPreviewChanges(sessionDiffs))
	const changedFiles = useMemo(() => webPreviewChangedFiles(sessionDiffs), [sessionDiffs])
	const revision = useMemo(() => webPreviewRevision(sessionDiffs), [sessionDiffs])

	const [cloudAvailable, setCloudAvailable] = useState(false)
	const [loopbackUrl, setLoopbackUrl] = useState<string | null>(null)
	const [workspaceEntryPath, setWorkspaceEntryPath] = useState<string | null>(null)
	const [mode, setMode] = useState<PreviewMode | null>(null)
	const dismissedRef = useRef(false)
	const [storedPanelWidth, setStoredPanelWidth] = useAtom(rightPanelWidthPercentAtom)
	const clampPanelWidth = useCallback((value: number) => Math.min(72, Math.max(28, value)), [])
	const [panelWidth, setPanelWidth] = useState(() => clampPanelWidth(storedPanelWidth))
	const deviceAvailable = Boolean(loopbackUrl || hasWorkspaceWebChanges || workspaceEntryPath)

	useEffect(() => {
		setPanelWidth(clampPanelWidth(storedPanelWidth))
	}, [clampPanelWidth, storedPanelWidth])

	const beginResize = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (event.button !== 0) return
			event.preventDefault()
			let finalWidth = panelWidth
			const previousCursor = document.body.style.cursor
			const previousUserSelect = document.body.style.userSelect
			document.body.style.cursor = "col-resize"
			document.body.style.userSelect = "none"

			const onPointerMove = (moveEvent: PointerEvent) => {
				finalWidth = clampPanelWidth(((window.innerWidth - moveEvent.clientX) / window.innerWidth) * 100)
				setPanelWidth(finalWidth)
			}
			const finish = () => {
				window.removeEventListener("pointermove", onPointerMove)
				window.removeEventListener("pointerup", finish)
				window.removeEventListener("pointercancel", finish)
				document.body.style.cursor = previousCursor
				document.body.style.userSelect = previousUserSelect
				setStoredPanelWidth(finalWidth)
			}

			window.addEventListener("pointermove", onPointerMove)
			window.addEventListener("pointerup", finish)
			window.addEventListener("pointercancel", finish)
		},
		[clampPanelWidth, panelWidth, setStoredPanelWidth],
	)

	const resizeWithKeyboard = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>) => {
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
			event.preventDefault()
			const next = clampPanelWidth(panelWidth + (event.key === "ArrowLeft" ? 2 : -2))
			setPanelWidth(next)
			setStoredPanelWidth(next)
		},
		[clampPanelWidth, panelWidth, setStoredPanelWidth],
	)

	useEffect(() => {
		dismissedRef.current = false
		setMode(null)
		setWorkspaceEntryPath(null)
	}, [previewContext?.sessionId])

	useEffect(() => {
		if (deviceAvailable && !dismissedRef.current) setMode("device")
	}, [deviceAvailable])

	const checkStatus = useCallback(async () => {
		let nextWorkspaceEntryPath: string | null = null
		if (previewContext) {
			try {
				nextWorkspaceEntryPath = await findWorkspacePreviewEntry(previewContext.directory)
			} catch {
				nextWorkspaceEntryPath = null
			}
		}
		setWorkspaceEntryPath(nextWorkspaceEntryPath)

		try {
			const response = await fetch("/api/browser/status", { cache: "no-store" })
			if (!response.ok) return
			const status = (await response.json()) as BrowserStatus
			const tabs = status.tabs ?? []
			const nextCloudAvailable = Boolean(status.connected && tabs.length > 0)
			const nextLoopbackUrl = tabs.find((tab) => isLoopbackPreviewUrl(tab.url))?.url ?? null
			setCloudAvailable(nextCloudAvailable)
			setLoopbackUrl(nextLoopbackUrl)
			if (
				!nextLoopbackUrl &&
				!hasWorkspaceWebChanges &&
				!nextWorkspaceEntryPath &&
				nextCloudAvailable &&
				!dismissedRef.current
			) {
				setMode("cloud")
			}
		} catch {
			// The cloud browser runtime is optional. Keep the chat usable while it is offline.
		}
	}, [hasWorkspaceWebChanges, previewContext])

	useEffect(() => {
		const checkWhenVisible = () => {
			if (!document.hidden) void checkStatus()
		}
		checkWhenVisible()
		const timer = window.setInterval(checkWhenVisible, 5_000)
		document.addEventListener("visibilitychange", checkWhenVisible)
		return () => {
			window.clearInterval(timer)
			document.removeEventListener("visibilitychange", checkWhenVisible)
		}
	}, [checkStatus])

	useEffect(() => {
		if (mode === "device" && !deviceAvailable) {
			setMode(cloudAvailable && !dismissedRef.current ? "cloud" : null)
		}
	}, [cloudAvailable, deviceAvailable, mode])

	const preferredMode: PreviewMode | null = deviceAvailable
		? "device"
		: cloudAvailable
			? "cloud"
			: null

	if (!mode) {
		if (!preferredMode) return null
		const isDevice = preferredMode === "device"
		return (
			<Button
				type="button"
				variant="outline"
				size="icon"
				className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-50 size-10 shadow-md lg:size-9"
				title="Show preview panel"
				onClick={() => {
					dismissedRef.current = false
					setMode(preferredMode)
				}}
			>
				{isDevice ? (
					<MonitorSmartphoneIcon aria-hidden="true" className="size-4" />
				) : (
					<Globe2Icon aria-hidden="true" className="size-4" />
				)}
				<span className="sr-only">Show preview panel</span>
			</Button>
		)
	}

	return (
		<aside
			className="fixed inset-0 z-[70] h-dvh w-full overflow-hidden bg-background lg:relative lg:inset-auto lg:z-20 lg:h-full lg:w-[var(--preview-panel-width)] lg:min-w-[320px] lg:max-w-[72vw] lg:shrink-0 lg:border-l lg:border-border"
			style={{ "--preview-panel-width": `${panelWidth}%` } as CSSProperties}
		>
			<div
				role="separator"
				aria-label="Resize preview panel"
				aria-orientation="vertical"
				tabIndex={0}
				onPointerDown={beginResize}
				onKeyDown={resizeWithKeyboard}
				className="absolute inset-y-0 left-0 z-40 hidden w-3 cursor-col-resize touch-none items-center justify-center outline-none focus-visible:bg-primary/10 lg:flex"
			>
				<div className="h-full w-px bg-border" />
			</div>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className="absolute right-2 top-[max(0.25rem,env(safe-area-inset-top))] z-30 size-10 bg-background/80 backdrop-blur lg:top-1 lg:size-8"
				title="Hide preview panel"
				onClick={() => {
					dismissedRef.current = true
					setMode(null)
				}}
			>
				<PanelRightCloseIcon aria-hidden="true" className="size-4" />
				<span className="sr-only">Hide preview panel</span>
			</Button>
			<Suspense
				fallback={
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						Loading preview…
					</div>
				}
			>
				{mode === "device" && loopbackUrl && previewContext ? (
					<LoopbackDevicePreviewView
						url={loopbackUrl}
						root={previewContext.directory}
						revision={revision}
					/>
				) : mode === "device" && previewContext ? (
					<DevicePreviewView
						root={previewContext.directory}
						changedFiles={changedFiles}
						revision={revision}
					/>
				) : (
					<BrowserLiveView />
				)}
			</Suspense>
		</aside>
	)
}
