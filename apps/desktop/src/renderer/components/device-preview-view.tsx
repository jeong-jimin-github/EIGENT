import { Button } from "@palot/ui/components/button"
import { MonitorSmartphoneIcon, RefreshCwIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { createWorkspacePreviewSession, devicePreviewUrl } from "../services/device-preview"

interface DevicePreviewViewProps {
	root: string
	changedFiles: string[]
	revision: string
}

export function DevicePreviewView({ root, changedFiles, revision }: DevicePreviewViewProps) {
	const [token, setToken] = useState<string | null>(null)
	const [entryPath, setEntryPath] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [manualRevision, setManualRevision] = useState(0)
	const changedFilesKey = changedFiles.join("\u0000")

	useEffect(() => {
		let cancelled = false
		setToken(null)
		setEntryPath(null)
		setError(null)
		void createWorkspacePreviewSession(root, changedFiles)
			.then((session) => {
				if (cancelled) return
				if (!session.entryPath) {
					setError("No HTML entry point was found in this web project.")
					return
				}
				setToken(session.token)
				setEntryPath(session.entryPath)
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : "Failed to create preview")
			})
		return () => {
			cancelled = true
		}
		// changedFilesKey tracks list contents without depending on array identity.
	}, [root, changedFilesKey])

	const src = useMemo(
		() =>
			token && entryPath
				? devicePreviewUrl(token, entryPath, `${revision}-${manualRevision}`)
				: null,
		[token, entryPath, revision, manualRevision],
	)

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3 pr-12">
				<MonitorSmartphoneIcon className="size-3.5 text-muted-foreground" />
				<span className="text-xs font-medium">Device Preview</span>
				<span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
					{entryPath ?? "Finding page entry…"}
				</span>
				<Button variant="ghost" size="icon-sm" title="Reload device preview" onClick={() => setManualRevision((value) => value + 1)}>
					<RefreshCwIcon className="size-3.5" />
				</Button>
			</div>
			{error ? (
				<div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-destructive">{error}</div>
			) : src ? (
				<iframe
					title="Device preview"
					src={src}
					className="min-h-0 flex-1 border-0 bg-white"
					sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts"
					referrerPolicy="no-referrer"
				/>
			) : (
				<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Preparing device preview…</div>
			)}
		</div>
	)
}
