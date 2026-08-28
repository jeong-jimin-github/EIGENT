/** noVNC-powered shared Linux desktop with explicit user/agent control handoff. */

import { Button } from "@palot/ui/components/button"
import { MonitorIcon, RefreshCwIcon, UploadIcon, UserRoundIcon, BotIcon } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import {
	desktopVncWebSocketUrl,
	ensureDesktop,
	fetchDesktopStatus,
	restartDesktop,
	returnDesktopControl,
	takeDesktopControl,
	uploadDesktopFile,
	type DesktopRuntimeStatus,
} from "../services/desktop-control"

type RfbClient = InstanceType<(typeof import("@novnc/novnc"))["default"]>

export function DesktopControlView() {
	const hostRef = useRef<HTMLDivElement>(null)
	const rfbRef = useRef<RfbClient | null>(null)
	const fileInputRef = useRef<HTMLInputElement>(null)
	const [status, setStatus] = useState<DesktopRuntimeStatus | null>(null)
	const [connected, setConnected] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [transfer, setTransfer] = useState<string | null>(null)

	const refreshStatus = useCallback(async () => {
		try {
			const next = await fetchDesktopStatus()
			setStatus(next)
			setError(next.lastError ?? null)
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load desktop status")
		}
	}, [])

	useEffect(() => {
		void refreshStatus()
		const timer = window.setInterval(() => void refreshStatus(), 3_000)
		return () => window.clearInterval(timer)
	}, [refreshStatus])

	useEffect(() => {
		if (!status?.ready || !hostRef.current) return
		let cancelled = false
		let rfb: RfbClient | null = null

		void import("@novnc/novnc")
			.then(({ default: RFB }) => {
				if (cancelled || !hostRef.current) return
				rfb = new RFB(hostRef.current, desktopVncWebSocketUrl())
				rfb.scaleViewport = true
				rfb.resizeSession = false
				rfb.clipViewport = false
				rfb.background = "#000"
				rfb.viewOnly = status.controlOwner !== "user"
				rfb.addEventListener("connect", () => setConnected(true))
				rfb.addEventListener("disconnect", () => setConnected(false))
				rfb.addEventListener("clipboard", (event) => {
					const text = (event as CustomEvent<{ text?: string }>).detail?.text
					if (text && navigator.clipboard?.writeText) void navigator.clipboard.writeText(text)
				})
				rfbRef.current = rfb
			})
			.catch((err) => setError(err instanceof Error ? err.message : "Failed to load noVNC"))

		return () => {
			cancelled = true
			rfb?.disconnect()
			if (rfbRef.current === rfb) rfbRef.current = null
			setConnected(false)
		}
	}, [status?.ready])

	useEffect(() => {
		if (rfbRef.current) rfbRef.current.viewOnly = status?.controlOwner !== "user"
	}, [status?.controlOwner])

	const ensure = useCallback(async () => {
		setBusy(true)
		setError(null)
		try {
			setStatus(await ensureDesktop())
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to start desktop")
		} finally {
			setBusy(false)
		}
	}, [])

	const restart = useCallback(async () => {
		setBusy(true)
		setError(null)
		try {
			rfbRef.current?.disconnect()
			setStatus(await restartDesktop())
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to restart desktop")
		} finally {
			setBusy(false)
		}
	}, [])

	const toggleControl = useCallback(async () => {
		setBusy(true)
		setError(null)
		try {
			const result =
				status?.controlOwner === "user" ? await returnDesktopControl() : await takeDesktopControl()
			setStatus((previous) =>
				previous
					? { ...previous, controlOwner: result.controlOwner, controlEpoch: result.controlEpoch }
					: previous,
			)
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to change desktop control")
		} finally {
			setBusy(false)
		}
	}, [status?.controlOwner])

	const pasteClipboard = useCallback(async () => {
		try {
			const text = await navigator.clipboard.readText()
			rfbRef.current?.clipboardPasteFrom(text)
		} catch (err) {
			setError(err instanceof Error ? err.message : "Clipboard access failed")
		}
	}, [])

	const upload = useCallback(async (file: File) => {
		setTransfer(`Uploading ${file.name}…`)
		try {
			const result = await uploadDesktopFile(file)
			setTransfer(`Uploaded to ${result.path}`)
		} catch (err) {
			setError(err instanceof Error ? err.message : "Desktop file upload failed")
			setTransfer(null)
		}
	}, [])

	const userHasControl = status?.controlOwner === "user"

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<div className="flex min-h-11 shrink-0 items-center gap-2 border-b px-3 py-2 max-sm:flex-wrap">
				<MonitorIcon className="size-4 shrink-0" aria-hidden="true" />
				<div className="min-w-0 flex-1">
					<div className="text-xs font-medium">Shared Desktop</div>
					<div className="truncate text-[11px] text-muted-foreground">
						{status?.supported
							? `${status.display} · ${status.geometry} · ${connected ? "VNC connected" : status.state}`
							: "Linux desktop runtime is unavailable on this host"}
					</div>
				</div>
				{status?.ready ? (
					<>
						<Button size="sm" variant="outline" className="h-7" onClick={pasteClipboard} disabled={!userHasControl}>
							Paste clipboard
						</Button>
						<Button size="sm" variant="outline" className="h-7" onClick={() => fileInputRef.current?.click()}>
							<UploadIcon className="size-3.5" aria-hidden="true" />
							Upload
						</Button>
						<Button
							size="sm"
							variant={userHasControl ? "secondary" : "default"}
							className="h-7"
							onClick={toggleControl}
							disabled={busy}
						>
							{userHasControl ? (
								<BotIcon className="size-3.5" aria-hidden="true" />
							) : (
								<UserRoundIcon className="size-3.5" aria-hidden="true" />
							)}
							{userHasControl ? "Return to Agent" : "Take Control"}
						</Button>
					</>
				) : (
					<Button
						size="sm"
						className="h-7"
						onClick={ensure}
						disabled={busy || status?.state === "unsupported"}
					>
						Start desktop
					</Button>
				)}
				<Button
					size="icon"
					variant="ghost"
					className="size-7"
					onClick={restart}
					disabled={busy || !status?.supported}
					title="Restart desktop"
				>
					<RefreshCwIcon className={`size-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden="true" />
				</Button>
				<input
					ref={fileInputRef}
					type="file"
					className="hidden"
					onChange={(event) => {
						const file = event.target.files?.[0]
						if (file) void upload(file)
						event.target.value = ""
					}}
				/>
			</div>

			{status?.ready ? (
				<div className="shrink-0 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
					{userHasControl
						? "You have exclusive input control. Agent mouse/keyboard actions are locked."
						: "Agent has input control. Desktop is view-only until you take over."}
				</div>
			) : null}
			{transfer ? (
				<div className="shrink-0 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
					{transfer}
				</div>
			) : null}
			{error ? (
				<div className="shrink-0 border-b px-3 py-2 text-xs text-destructive">{error}</div>
			) : null}
			<div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden bg-black" />
		</div>
	)
}
