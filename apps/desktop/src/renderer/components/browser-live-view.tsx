import { Button } from "@palot/ui/components/button"
import {
	AlertTriangleIcon,
	DownloadIcon,
	EyeIcon,
	Loader2Icon,
	RadioIcon,
	RefreshCwIcon,
	UploadIcon,
	WifiOffIcon,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import {
	browserLiveWebSocketUrl,
	handleBrowserDialog,
	reloadBrowserPage,
	type BrowserLiveServerMessage,
	type BrowserLiveSnapshot,
} from "../services/browser-live"
import { reconnectDelay } from "../services/eigent-recovery"

type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline"

function activityLabel(snapshot: BrowserLiveSnapshot | null): string {
	const activity = snapshot?.activity
	if (!activity) return "Waiting for browser activity"
	if (activity.kind === "action" && activity.action) return `${activity.action} · ${activity.phase}`
	return `${activity.kind} · ${activity.phase}`
}

export function BrowserLiveView() {
	const [snapshot, setSnapshot] = useState<BrowserLiveSnapshot | null>(null)
	const [connectionState, setConnectionState] = useState<ConnectionState>("connecting")
	const [error, setError] = useState<string | null>(null)
	const [followAgent, setFollowAgent] = useState(true)
	const [generation, setGeneration] = useState(0)
	const socketRef = useRef<WebSocket | null>(null)

	useEffect(() => {
		let stopped = false
		let reconnectAttempt = 0
		let reconnectTimer: number | null = null
		const compact = window.matchMedia("(max-width: 640px)").matches
		const fps = compact ? 1 : 2
		const quality = compact ? 30 : 40

		const scheduleReconnect = () => {
			if (stopped || reconnectTimer !== null) return
			setConnectionState(navigator.onLine ? "reconnecting" : "offline")
			const delay = reconnectDelay(reconnectAttempt, { baseMs: 500, maxMs: 8_000 })
			reconnectAttempt += 1
			reconnectTimer = window.setTimeout(() => {
				reconnectTimer = null
				connect()
			}, delay)
		}

		const connect = () => {
			if (stopped) return
			const current = socketRef.current
			if (current?.readyState === WebSocket.OPEN || current?.readyState === WebSocket.CONNECTING) return
			setConnectionState(reconnectAttempt > 0 ? "reconnecting" : "connecting")
			const socket = new WebSocket(browserLiveWebSocketUrl({ fps, quality }))
			socketRef.current = socket

			socket.addEventListener("open", () => {
				if (stopped || socketRef.current !== socket) return
				reconnectAttempt = 0
				setConnectionState("connected")
				setError(null)
			})
			socket.addEventListener("message", (event) => {
				if (socketRef.current !== socket) return
				try {
					const message = JSON.parse(String(event.data)) as BrowserLiveServerMessage
					if (message.type === "error") {
						setError(message.error)
						return
					}
					setError(null)
					setSnapshot((previous) => ({
						...message.snapshot,
						imageBase64: message.snapshot.imageBase64 ?? previous?.imageBase64,
					}))
				} catch {
					setError("Invalid Browser Live View message")
				}
			})
			socket.addEventListener("close", () => {
				if (socketRef.current !== socket) return
				socketRef.current = null
				scheduleReconnect()
			})
			socket.addEventListener("error", () => socket.close())
		}

		const reconnectNow = () => {
			if (reconnectTimer !== null) {
				window.clearTimeout(reconnectTimer)
				reconnectTimer = null
			}
			socketRef.current?.close()
			socketRef.current = null
			connect()
		}

		connect()
		window.addEventListener("online", reconnectNow)
		window.addEventListener("offline", scheduleReconnect)
		return () => {
			stopped = true
			window.removeEventListener("online", reconnectNow)
			window.removeEventListener("offline", scheduleReconnect)
			if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
			socketRef.current?.close()
			socketRef.current = null
		}
	}, [generation])

	const sendControl = useCallback((message: Record<string, unknown>) => {
		const socket = socketRef.current
		if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
	}, [])

	const selectTab = useCallback(
		(pageId: string) => {
			setFollowAgent(false)
			sendControl({ type: "select", pageId })
		},
		[sendControl],
	)

	const resumeFollowing = useCallback(() => {
		setFollowAgent(true)
		sendControl({ type: "follow" })
	}, [sendControl])

	const reload = useCallback(async () => {
		if (!snapshot?.pageId) return
		try {
			setError(null)
			await reloadBrowserPage(snapshot.pageId)
			sendControl({ type: "refresh" })
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to reload browser page")
		}
	}, [sendControl, snapshot?.pageId])

	const answerDialog = useCallback(
		async (accept: boolean) => {
			if (!snapshot?.dialog || !snapshot.pageId) return
			let promptText: string | undefined
			if (accept && snapshot.dialog.type === "prompt") {
				const answer = window.prompt(snapshot.dialog.message, snapshot.dialog.defaultValue ?? "")
				if (answer === null) return
				promptText = answer
			}
			try {
				await handleBrowserDialog(snapshot.pageId, accept, promptText)
				sendControl({ type: "refresh" })
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to handle browser dialog")
			}
		},
		[sendControl, snapshot],
	)

	const recentTransfer =
		snapshot?.transfer && Date.now() - snapshot.transfer.at < 20_000 ? snapshot.transfer : null
	const imageSource = snapshot?.imageBase64
		? `data:${snapshot.mimeType};base64,${snapshot.imageBase64}`
		: null

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<div className="flex min-h-11 shrink-0 items-center gap-2 border-b px-3 py-2 max-sm:min-h-10 max-sm:px-2">
				<RadioIcon className="size-4 shrink-0" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2 text-xs font-medium">
						<span>Browser Live</span>
						<span className="truncate text-muted-foreground">{activityLabel(snapshot)}</span>
					</div>
					<div className="truncate text-[11px] text-muted-foreground max-sm:hidden">
						{snapshot?.title || snapshot?.url || "Shared persistent browser"}
					</div>
				</div>
				<Button
					variant={followAgent ? "secondary" : "ghost"}
					size="sm"
					className="h-7 gap-1 px-2 text-xs"
					onClick={resumeFollowing}
					title="Follow the tab currently controlled by the agent"
				>
					<EyeIcon className="size-3.5" />
					<span className="max-sm:hidden">Follow agent</span>
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className="size-7"
					onClick={() => void reload()}
					disabled={!snapshot}
					title="Reload page"
				>
					<RefreshCwIcon className={`size-3.5 ${snapshot?.loading ? "animate-spin" : ""}`} />
				</Button>
				{connectionState !== "connected" ? (
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						onClick={() => setGeneration((value) => value + 1)}
						title="Reconnect live view"
					>
						<WifiOffIcon className="size-3.5" />
					</Button>
				) : null}
			</div>

			<div className="flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1.5">
				{snapshot?.tabs.map((tab) => (
					<button
						key={tab.id}
						type="button"
						onClick={() => selectTab(tab.id)}
						className={`max-w-48 shrink-0 rounded-md px-2 py-1 text-left text-[11px] transition-colors ${
							tab.id === snapshot.pageId
								? "bg-muted font-medium text-foreground"
								: "text-muted-foreground hover:bg-muted/60"
						}`}
						title={tab.url}
					>
						<span className="flex items-center gap-1.5">
							{tab.loading ? <Loader2Icon className="size-3 shrink-0 animate-spin" /> : null}
							<span className="truncate">{tab.title || tab.url || "New tab"}</span>
						</span>
					</button>
				))}
				{!snapshot?.tabs.length ? (
					<span className="px-2 py-1 text-[11px] text-muted-foreground">No browser tabs</span>
				) : null}
			</div>

			<div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[11px] max-sm:px-2">
				<span
					className={`size-1.5 shrink-0 rounded-full ${
						connectionState === "connected" ? "bg-emerald-500" : "bg-amber-500"
					}`}
				/>
				<span className="shrink-0 capitalize text-muted-foreground">{connectionState}</span>
				<span className="min-w-0 flex-1 truncate font-mono">
					{snapshot?.url ?? "Connecting to persistent browser…"}
				</span>
				{snapshot?.viewport ? (
					<span className="shrink-0 text-muted-foreground max-sm:hidden">
						{snapshot.viewport.width}×{snapshot.viewport.height}
					</span>
				) : null}
			</div>

			{snapshot?.dialog ? (
				<div className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 py-2 text-xs max-sm:flex-wrap max-sm:px-2">
					<AlertTriangleIcon className="size-4 shrink-0 text-amber-600" />
					<span className="min-w-0 flex-1 truncate">
						{snapshot.dialog.type}: {snapshot.dialog.message}
					</span>
					<Button
						size="sm"
						variant="outline"
						className="h-7"
						onClick={() => void answerDialog(false)}
					>
						Dismiss
					</Button>
					<Button size="sm" className="h-7" onClick={() => void answerDialog(true)}>
						Accept
					</Button>
				</div>
			) : null}

			{recentTransfer ? (
				<div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[11px] text-muted-foreground max-sm:px-2">
					{recentTransfer.kind === "download" ? (
						<DownloadIcon className="size-3.5" />
					) : (
						<UploadIcon className="size-3.5" />
					)}
					<span className="capitalize">
						{recentTransfer.kind} {recentTransfer.state}
					</span>
					<span className="truncate">
						{recentTransfer.filename ?? recentTransfer.files?.join(", ")}
					</span>
				</div>
			) : null}

			{error ? (
				<div className="shrink-0 border-b px-3 py-2 text-xs text-destructive">{error}</div>
			) : null}

			<div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-2 max-sm:p-0">
				{imageSource ? (
					<img
						src={imageSource}
						alt="Live browser viewport"
						className="max-h-full max-w-full select-none object-contain"
						draggable={false}
					/>
				) : (
					<div className="flex items-center gap-2 text-xs text-white/60">
						{connectionState === "offline" ? (
							<WifiOffIcon className="size-4" />
						) : (
							<Loader2Icon className="size-4 animate-spin" />
						)}
						<span>
							{connectionState === "offline"
								? "Browser Live View is offline"
								: "Waiting for first browser frame…"}
						</span>
					</div>
				)}
			</div>
		</div>
	)
}
