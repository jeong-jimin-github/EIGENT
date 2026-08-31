import { Button } from "@palot/ui/components/button"
import { Globe2Icon, MonitorSmartphoneIcon, PanelRightCloseIcon } from "lucide-react"
import { useAtomValue } from "jotai"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { activePreviewContextAtom, sessionDiffFamily } from "../atoms/ui"
import {
	hasWebPreviewChanges,
	isLoopbackPreviewUrl,
	webPreviewChangedFiles,
	webPreviewRevision,
} from "../services/device-preview"
import { BrowserLiveView } from "./browser-live-view"
import { DevicePreviewView } from "./device-preview-view"
import { LoopbackDevicePreviewView } from "./loopback-device-preview-view"

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
	const [mode, setMode] = useState<PreviewMode | null>(null)
	const dismissedRef = useRef(false)
	const deviceAvailable = Boolean(loopbackUrl || hasWorkspaceWebChanges)

	useEffect(() => {
		dismissedRef.current = false
		setMode(null)
	}, [previewContext?.sessionId])

	useEffect(() => {
		if (deviceAvailable && !dismissedRef.current) setMode("device")
	}, [deviceAvailable])

	const checkStatus = useCallback(async () => {
		try {
			const response = await fetch("/api/browser/status", { cache: "no-store" })
			if (!response.ok) return
			const status = (await response.json()) as BrowserStatus
			const tabs = status.tabs ?? []
			const nextCloudAvailable = Boolean(status.connected && tabs.length > 0)
			const nextLoopbackUrl = tabs.find((tab) => isLoopbackPreviewUrl(tab.url))?.url ?? null
			setCloudAvailable(nextCloudAvailable)
			setLoopbackUrl(nextLoopbackUrl)
			if (!nextLoopbackUrl && !hasWorkspaceWebChanges && nextCloudAvailable && !dismissedRef.current) {
				setMode("cloud")
			}
		} catch {
			// The cloud browser runtime is optional. Keep the chat usable while it is offline.
		}
	}, [hasWorkspaceWebChanges])

	useEffect(() => {
		void checkStatus()
		const timer = window.setInterval(() => void checkStatus(), 2_000)
		return () => window.clearInterval(timer)
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
				className="fixed bottom-4 right-4 z-50 shadow-md"
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
		<aside className="relative z-20 hidden h-full w-[45vw] min-w-[420px] max-w-[760px] shrink-0 border-l border-border bg-background lg:block">
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className="absolute right-2 top-1 z-30 bg-background/80 backdrop-blur"
				title="Hide preview panel"
				onClick={() => {
					dismissedRef.current = true
					setMode(null)
				}}
			>
				<PanelRightCloseIcon aria-hidden="true" className="size-4" />
				<span className="sr-only">Hide preview panel</span>
			</Button>
			{mode === "device" && loopbackUrl ? (
				<LoopbackDevicePreviewView url={loopbackUrl} revision={revision} />
			) : mode === "device" && previewContext ? (
				<DevicePreviewView
					root={previewContext.directory}
					changedFiles={changedFiles}
					revision={revision}
				/>
			) : (
				<BrowserLiveView />
			)}
		</aside>
	)
}
