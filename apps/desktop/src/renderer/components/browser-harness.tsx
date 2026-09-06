import { Button } from "@palot/ui/components/button"
import { MonitorSmartphoneIcon, PanelRightCloseIcon } from "lucide-react"
import { useAtom, useAtomValue } from "jotai"
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react"
import { activePreviewContextAtom, rightPanelWidthPercentAtom } from "../atoms/ui"
import { fetchSessionPreview, type SessionPreviewState } from "../services/device-preview"

const DevicePreviewView = lazy(() =>
	import("./device-preview-view").then((module) => ({ default: module.DevicePreviewView })),
)
const LoopbackDevicePreviewView = lazy(() =>
	import("./loopback-device-preview-view").then((module) => ({
		default: module.LoopbackDevicePreviewView,
	})),
)

export function BrowserHarness() {
	const previewContext = useAtomValue(activePreviewContextAtom)
	const [preview, setPreview] = useState<SessionPreviewState | null>(null)
	const [visible, setVisible] = useState(false)
	const activationRef = useRef<string | null>(null)
	const [storedPanelWidth, setStoredPanelWidth] = useAtom(rightPanelWidthPercentAtom)
	const clampPanelWidth = useCallback((value: number) => Math.min(72, Math.max(28, value)), [])
	const [panelWidth, setPanelWidth] = useState(() => clampPanelWidth(storedPanelWidth))

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
		const sessionId = previewContext?.sessionId
		activationRef.current = null
		setPreview(null)
		setVisible(false)
		if (!sessionId) return

		let active = true
		let controller: AbortController | null = null
		const poll = async () => {
			if (document.hidden) return
			controller?.abort()
			controller = new AbortController()
			try {
				const next = await fetchSessionPreview(sessionId, controller.signal)
				if (!active) return
				setPreview(next)
				if (!next) {
					activationRef.current = null
								setVisible(false)
					return
				}
				if (activationRef.current !== next.activationId) {
					activationRef.current = next.activationId
								setVisible(true)
				}
			} catch (error) {
				if (error instanceof DOMException && error.name === "AbortError") return
				// Keep the last known preview visible while the server reconnects.
			}
		}
		const checkWhenVisible = () => {
			if (!document.hidden) void poll()
		}
		void poll()
		const timer = window.setInterval(checkWhenVisible, 1_000)
		document.addEventListener("visibilitychange", checkWhenVisible)
		return () => {
			active = false
			controller?.abort()
			window.clearInterval(timer)
			document.removeEventListener("visibilitychange", checkWhenVisible)
		}
	}, [previewContext?.sessionId])

	if (!visible) {
		if (!preview) return null
		return (
			<Button
				type="button"
				variant="outline"
				size="icon"
				className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-50 size-10 shadow-md lg:size-9"
				title="Show preview panel"
				onClick={() => {
								setVisible(true)
				}}
			>
				<MonitorSmartphoneIcon aria-hidden="true" className="size-4" />
				<span className="sr-only">Show preview panel</span>
			</Button>
		)
	}

	if (!preview) return null

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
						setVisible(false)
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
				{preview.kind === "loopback" ? (
					<LoopbackDevicePreviewView
						url={preview.url}
						root={preview.root}
						revision={String(preview.revision)}
						sessionId={preview.sessionId}
					/>
				) : (
					<DevicePreviewView
						root={preview.root}
						changedFiles={[]}
						entryPath={preview.path}
						revision={String(preview.revision)}
						sessionId={preview.sessionId}
					/>
				)}
			</Suspense>
		</aside>
	)
}
