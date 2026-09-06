import { Button } from "@palot/ui/components/button"
import { MonitorSmartphoneIcon, RefreshCwIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import {
	createLoopbackPreviewSession,
	fetchDevicePreviewReloadState,
	loopbackPreviewUrl,
	requestDevicePreviewReload,
	requestSessionPreviewReload,
} from "../services/device-preview"

interface LoopbackDevicePreviewViewProps {
	url: string
	root: string
	revision: string
	sessionId?: string
}

export function LoopbackDevicePreviewView({ url, root, revision, sessionId }: LoopbackDevicePreviewViewProps) {
	const [token, setToken] = useState<string | null>(null)
	const [initialPath, setInitialPath] = useState("/")
	const [error, setError] = useState<string | null>(null)
	const [manualRevision, setManualRevision] = useState(0)
	const [remoteRevision, setRemoteRevision] = useState(0)

	useEffect(() => {
		if (sessionId) {
			setRemoteRevision(0)
			return
		}
		const controller = new AbortController()
		let active = true
		const poll = async () => {
			try {
				const state = await fetchDevicePreviewReloadState(root, controller.signal)
				if (active) setRemoteRevision(state.revision)
			} catch {
				// Keep the active localhost preview visible while reload control reconnects.
			}
		}
		void poll()
		const timer = window.setInterval(() => void poll(), 750)
		return () => {
			active = false
			controller.abort()
			window.clearInterval(timer)
		}
	}, [root, sessionId])

	useEffect(() => {
		let cancelled = false
		setToken(null)
		setError(null)
		void createLoopbackPreviewSession(url, sessionId)
			.then((session) => {
				if (cancelled) return
				setToken(session.token)
				setInitialPath(session.path)
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : "Failed to proxy dev server")
			})
		return () => {
			cancelled = true
		}
	}, [url, sessionId])

	const src = useMemo(
		() =>
			token
				? loopbackPreviewUrl(token, initialPath, `${revision}-${manualRevision}-${remoteRevision}`)
				: null,
		[token, initialPath, revision, manualRevision, remoteRevision],
	)

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3 pr-12">
				<MonitorSmartphoneIcon className="size-3.5 text-muted-foreground" />
				<span className="text-xs font-medium">Device Preview</span>
				<span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{url}</span>
				<Button
					variant="ghost"
					size="icon-sm"
					title="Reload device preview"
					onClick={() => {
						const reload = sessionId
							? requestSessionPreviewReload(sessionId).then((state) => setRemoteRevision(state.revision))
							: requestDevicePreviewReload(root).then((state) => setRemoteRevision(state.revision))
						void reload.catch(() => setManualRevision((value) => value + 1))
					}}
				>
					<RefreshCwIcon className="size-3.5" />
				</Button>
			</div>
			{error ? (
				<div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-destructive">
					{error}
				</div>
			) : src ? (
				<iframe
					title="Device preview"
					src={src}
					className="min-h-0 flex-1 border-0 bg-white"
					sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts"
					referrerPolicy="no-referrer"
				/>
			) : (
				<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
					Connecting device preview…
				</div>
			)}
		</div>
	)
}
