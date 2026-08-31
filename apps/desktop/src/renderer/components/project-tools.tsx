/** Project-scoped Files, PTY Terminal, and Process Manager UI. */
import { Button } from "@palot/ui/components/button"
import { Input } from "@palot/ui/components/input"
import { ScrollArea } from "@palot/ui/components/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@palot/ui/components/tabs"
import { Textarea } from "@palot/ui/components/textarea"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal as XTerm } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { useNavigate, useParams } from "@tanstack/react-router"
import { useAtomValue } from "jotai"
import {
	ChevronLeftIcon,
	FileIcon,
	FolderIcon,
	FolderPlusIcon,
	PlayIcon,
	RefreshCwIcon,
	SaveIcon,
	SquareIcon,
	TerminalIcon,
	Trash2Icon,
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { discoveryLoadedAtom } from "../atoms/discovery"
import { useProjectList } from "../hooks/use-agents"
import { isHtmlPreviewPath } from "../services/device-preview"
import { fetchRecoverySnapshot, reconnectDelay, watchRecoverySnapshots } from "../services/eigent-recovery"
import {
	createWorkspaceDirectory,
	deleteWorkspacePath,
	killProcess,
	listWorkspace,
	readWorkspaceFile,
	resolveWorkspaceRoot,
	startProcess,
	terminalWebSocketUrl,
	writeWorkspaceFile,
	type ManagedProcessInfo,
	type WorkspaceEntry,
} from "../services/project-tools"
import { useSetAppBarContent } from "./app-bar-context"
import { BrowserLiveView } from "./browser-live-view"
import { DesktopControlView } from "./desktop-control-view"
import { DevicePreviewView } from "./device-preview-view"

export function ProjectTools() {
	const { projectSlug } = useParams({ strict: false }) as { projectSlug?: string }
	const navigate = useNavigate()
	const discoveryLoaded = useAtomValue(discoveryLoadedAtom)
	const projects = useProjectList()
	const project =
		projects.find((item) => item.slug === projectSlug) ??
		(projectSlug === "no-project"
			? {
					id: "__eigent-no-project__",
					slug: "no-project",
					name: "No Project",
					directory: "",
					agentCount: 0,
					lastActiveAt: 0,
					hasActiveAgent: false,
					isNoProject: true,
				}
			: undefined)
	const setAppBarContent = useSetAppBarContent()
	const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null)
	const [workspaceError, setWorkspaceError] = useState<string | null>(null)

	// Old global sessions could leave bookmarks such as /project/ubuntu-dir-.../tools.
	// Once discovery is complete and that synthetic project no longer exists,
	// repair the route instead of trying to resolve an unsafe legacy directory.
	useEffect(() => {
		if (!discoveryLoaded || project || !projectSlug || projectSlug === "no-project") return
		void navigate({
			to: "/project/$projectSlug/tools",
			params: { projectSlug: "no-project" },
			replace: true,
		})
	}, [discoveryLoaded, navigate, project, projectSlug])

	useEffect(() => {
		if (!project) {
			setWorkspaceRoot(null)
			setWorkspaceError(null)
			return
		}
		let cancelled = false
		setWorkspaceRoot(null)
		setWorkspaceError(null)
		void resolveWorkspaceRoot(project.directory)
			.then((root) => {
				if (!cancelled) setWorkspaceRoot(root)
			})
			.catch((error) => {
				if (!cancelled) {
					setWorkspaceError(error instanceof Error ? error.message : "Failed to resolve workspace")
				}
			})
		return () => {
			cancelled = true
		}
	}, [project])

	useEffect(() => {
		setAppBarContent(
			<div className="flex min-w-0 items-center gap-2 text-sm">
				<span className="font-medium">Project Tools</span>
				{workspaceRoot ? <span className="truncate text-muted-foreground">{workspaceRoot}</span> : null}
			</div>,
		)
		return () => setAppBarContent(null)
	}, [project, setAppBarContent, workspaceRoot])

	if (!project) {
		return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Project not found</div>
	}
	if (workspaceError) {
		return <div className="flex h-full items-center justify-center text-sm text-destructive">{workspaceError}</div>
	}
	if (!workspaceRoot) {
		return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading workspace…</div>
	}

	return (
		<Tabs defaultValue="files" className="h-full min-h-0 gap-0">
			<div className="shrink-0 border-b px-3 py-2">
				<TabsList variant="line">
					<TabsTrigger value="files">Files</TabsTrigger>
					<TabsTrigger value="terminal">Terminal</TabsTrigger>
					<TabsTrigger value="processes">Processes</TabsTrigger>
					<TabsTrigger value="browser">Browser</TabsTrigger>
					<TabsTrigger value="desktop">Desktop</TabsTrigger>
				</TabsList>
			</div>
			<TabsContent value="files" className="min-h-0 overflow-hidden">
				<FilesPanel root={workspaceRoot} />
			</TabsContent>
			<TabsContent value="terminal" className="min-h-0 overflow-hidden">
				<TerminalPanel cwd={workspaceRoot} />
			</TabsContent>
			<TabsContent value="processes" className="min-h-0 overflow-hidden">
				<ProcessesPanel cwd={workspaceRoot} />
			</TabsContent>
			<TabsContent value="browser" className="min-h-0 overflow-hidden">
				<BrowserLiveView />
			</TabsContent>
			<TabsContent value="desktop" className="min-h-0 overflow-hidden">
				<DesktopControlView />
			</TabsContent>
		</Tabs>
	)
}

function FilesPanel({ root }: { root: string }) {
	const [directory, setDirectory] = useState("")
	const [entries, setEntries] = useState<WorkspaceEntry[]>([])
	const [selectedPath, setSelectedPath] = useState<string | null>(null)
	const [content, setContent] = useState("")
	const [savedContent, setSavedContent] = useState("")
	const [fileView, setFileView] = useState<"source" | "preview">("source")
	const [previewRevision, setPreviewRevision] = useState(0)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		setLoading(true)
		setError(null)
		try {
			setEntries(await listWorkspace(root, directory))
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to list workspace")
		} finally {
			setLoading(false)
		}
	}, [root, directory])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const openEntry = useCallback(
		async (entry: WorkspaceEntry) => {
			if (entry.type === "directory") {
				setDirectory(entry.path)
				setSelectedPath(null)
				setContent("")
				setSavedContent("")
				setFileView("source")
				return
			}
			if (entry.type !== "file") return
			setError(null)
			try {
				const file = await readWorkspaceFile(root, entry.path)
				setSelectedPath(file.path)
				setContent(file.content)
				setSavedContent(file.content)
				setFileView(isHtmlPreviewPath(file.path) ? "preview" : "source")
				if (isHtmlPreviewPath(file.path)) setPreviewRevision((value) => value + 1)
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to read file")
			}
		},
		[root],
	)

	const goParent = useCallback(() => {
		const parts = directory.split("/").filter(Boolean)
		parts.pop()
		setDirectory(parts.join("/"))
		setSelectedPath(null)
	}, [directory])

	const createFolder = useCallback(async () => {
		const name = window.prompt("Folder name")?.trim()
		if (!name) return
		const target = directory ? `${directory}/${name}` : name
		try {
			await createWorkspaceDirectory(root, target)
			await refresh()
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to create folder")
		}
	}, [directory, refresh, root])

	const save = useCallback(async () => {
		if (!selectedPath) return
		try {
			await writeWorkspaceFile(root, selectedPath, content)
			setSavedContent(content)
			if (isHtmlPreviewPath(selectedPath)) setPreviewRevision((value) => value + 1)
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save file")
		}
	}, [content, root, selectedPath])

	const removeSelected = useCallback(async () => {
		if (!selectedPath || !window.confirm(`Delete ${selectedPath}?`)) return
		try {
			await deleteWorkspacePath(root, selectedPath)
			setSelectedPath(null)
			setContent("")
			setSavedContent("")
			await refresh()
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to delete file")
		}
	}, [refresh, root, selectedPath])

	return (
		<div className="grid h-full min-h-0 grid-cols-[minmax(190px,28%)_1fr] max-sm:grid-cols-1 max-sm:grid-rows-[42%_58%]">
			<div className="flex min-h-0 flex-col border-r max-sm:border-b max-sm:border-r-0">
				<div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
					<Button variant="ghost" size="icon" className="size-7" disabled={!directory} onClick={goParent}>
						<ChevronLeftIcon aria-hidden="true" className="size-4" />
					</Button>
					<div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">/{directory}</div>
					<Button variant="ghost" size="icon" className="size-7" onClick={createFolder}>
						<FolderPlusIcon aria-hidden="true" className="size-4" />
					</Button>
					<Button variant="ghost" size="icon" className="size-7" onClick={refresh} disabled={loading}>
						<RefreshCwIcon aria-hidden="true" className={`size-4 ${loading ? "animate-spin" : ""}`} />
					</Button>
				</div>
				<ScrollArea className="min-h-0 flex-1">
					<div className="p-1.5">
						{entries.map((entry) => (
							<button
								key={entry.path}
								type="button"
								onClick={() => void openEntry(entry)}
								className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted ${selectedPath === entry.path ? "bg-muted" : ""}`}
							>
								{entry.type === "directory" ? (
									<FolderIcon aria-hidden="true" className="size-3.5 shrink-0" />
								) : (
									<FileIcon aria-hidden="true" className="size-3.5 shrink-0" />
								)}
								<span className="truncate">{entry.name}</span>
							</button>
						))}
					</div>
				</ScrollArea>
			</div>

			<div className="flex min-h-0 min-w-0 flex-col">
				<div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
					<div className="min-w-0 flex-1 truncate text-xs font-medium">
						{selectedPath ?? "Select a text file"}
					</div>
					{selectedPath ? (
						<>
							{isHtmlPreviewPath(selectedPath) ? (
								<>
									<Button
										variant={fileView === "preview" ? "secondary" : "ghost"}
										size="sm"
										onClick={() => setFileView("preview")}
									>
										Preview
									</Button>
									<Button
										variant={fileView === "source" ? "secondary" : "ghost"}
										size="sm"
										onClick={() => setFileView("source")}
									>
										Source
									</Button>
								</>
							) : null}
							<Button variant="ghost" size="sm" onClick={removeSelected}>
								<Trash2Icon aria-hidden="true" className="size-3.5" />
								Delete
							</Button>
							<Button size="sm" disabled={content === savedContent} onClick={save}>
								<SaveIcon aria-hidden="true" className="size-3.5" />
								Save
							</Button>
						</>
					) : null}
				</div>
				{error ? <div className="shrink-0 border-b px-3 py-2 text-xs text-destructive">{error}</div> : null}
				{selectedPath && isHtmlPreviewPath(selectedPath) && fileView === "preview" ? (
					<DevicePreviewView
						root={root}
						changedFiles={[selectedPath]}
						revision={`${selectedPath}-${previewRevision}`}
					/>
				) : selectedPath ? (
					<Textarea
						value={content}
						onChange={(event) => setContent(event.target.value)}
						spellCheck={false}
						className="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-xs leading-relaxed focus-visible:ring-0"
					/>
				) : (
					<div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
						Choose a file from the workspace tree.
					</div>
				)}
			</div>
		</div>
	)
}

function TerminalPanel({ cwd }: { cwd: string }) {
	const hostRef = useRef<HTMLDivElement>(null)
	const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "reconnecting">(
		"connecting",
	)

	useEffect(() => {
		const host = hostRef.current
		if (!host) return

		const terminal = new XTerm({
			cursorBlink: true,
			fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
			fontSize: 13,
			scrollback: 5000,
		})
		const fitAddon = new FitAddon()
		terminal.loadAddon(fitAddon)
		terminal.open(host)
		fitAddon.fit()

		let socket: WebSocket | null = null
		let stopped = false
		let reconnectAttempt = 0
		let reconnectTimer: number | null = null

		const scheduleReconnect = () => {
			if (stopped || reconnectTimer !== null) return
			setConnectionState("reconnecting")
			const delay = reconnectDelay(reconnectAttempt, { baseMs: 500, maxMs: 10_000 })
			reconnectAttempt += 1
			reconnectTimer = window.setTimeout(() => {
				reconnectTimer = null
				connect()
			}, delay)
		}

		const connect = () => {
			if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return
			setConnectionState(reconnectAttempt > 0 ? "reconnecting" : "connecting")
			const next = new WebSocket(terminalWebSocketUrl(cwd))
			socket = next
			next.addEventListener("open", () => {
				if (socket !== next || stopped) return
				reconnectAttempt = 0
				setConnectionState("connected")
				fitAddon.fit()
				next.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }))
				terminal.focus()
			})
			next.addEventListener("message", (event) => {
				if (socket === next) terminal.write(String(event.data))
			})
			next.addEventListener("close", () => {
				if (socket !== next) return
				socket = null
				scheduleReconnect()
			})
			next.addEventListener("error", () => next.close())
		}

		const reconnectNow = () => {
			if (reconnectTimer !== null) {
				window.clearTimeout(reconnectTimer)
				reconnectTimer = null
			}
			socket?.close()
			socket = null
			connect()
		}

		connect()
		window.addEventListener("online", reconnectNow)

		const inputDisposable = terminal.onData((data) => {
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ type: "input", data }))
			}
		})
		const resizeObserver = new ResizeObserver(() => {
			fitAddon.fit()
			if (socket?.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }))
			}
		})
		resizeObserver.observe(host)

		return () => {
			stopped = true
			window.removeEventListener("online", reconnectNow)
			if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
			resizeObserver.disconnect()
			inputDisposable.dispose()
			socket?.close()
			terminal.dispose()
		}
	}, [cwd])

	return (
		<div className="flex h-full min-h-0 flex-col bg-black">
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/10 px-3 text-xs text-white/60">
				<TerminalIcon aria-hidden="true" className="size-3.5" />
				<span className="truncate">{cwd}</span>
				<span className="ml-auto">{connectionState}</span>
			</div>
			<div ref={hostRef} className="min-h-0 flex-1 p-2" />
		</div>
	)
}

function ProcessesPanel({ cwd }: { cwd: string }) {
	const [command, setCommand] = useState("")
	const [processes, setProcesses] = useState<ManagedProcessInfo[]>([])
	const [error, setError] = useState<string | null>(null)
	const [starting, setStarting] = useState(false)

	const refresh = useCallback(async () => {
		try {
			const snapshot = await fetchRecoverySnapshot(cwd)
			setProcesses(snapshot.processes)
			setError(null)
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to recover process state")
		}
	}, [cwd])

	useEffect(() => {
		const controller = new AbortController()
		void watchRecoverySnapshots(
			cwd,
			(snapshot) => {
				setProcesses(snapshot.processes)
				setError(null)
			},
			(err) => setError(err instanceof Error ? err.message : "Reconnecting to server…"),
			controller.signal,
		)
		return () => controller.abort()
	}, [cwd])

	const projectProcesses = processes

	const run = useCallback(async () => {
		const trimmed = command.trim()
		if (!trimmed) return
		setStarting(true)
		try {
			await startProcess(trimmed, cwd)
			setCommand("")
			await refresh()
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to start process")
		} finally {
			setStarting(false)
		}
	}, [command, cwd, refresh])

	const stop = useCallback(
		async (id: string) => {
			try {
				await killProcess(id)
				await refresh()
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to stop process")
			}
		},
		[refresh],
	)

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 gap-2 border-b p-3">
				<Input
					value={command}
					onChange={(event) => setCommand(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") void run()
					}}
					placeholder="npm run dev, bun test, godot --headless …"
					className="font-mono text-xs"
				/>
				<Button onClick={run} disabled={!command.trim() || starting}>
					<PlayIcon aria-hidden="true" className="size-3.5" />
					Run
				</Button>
			</div>
			{error ? (
				<div className="shrink-0 border-b px-3 py-2 text-xs text-destructive">{error}</div>
			) : null}
			<ScrollArea className="min-h-0 flex-1">
				<div className="space-y-2 p-3">
					{projectProcesses.length === 0 ? (
						<div className="py-10 text-center text-xs text-muted-foreground">
							No managed processes for this project.
						</div>
					) : (
						projectProcesses.map((item) => (
							<div key={item.id} className="overflow-hidden rounded-lg border bg-card">
								<div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
									<span className="min-w-0 flex-1 truncate font-mono">{item.command}</span>
									<span className="text-muted-foreground">{item.state}</span>
									{item.state === "running" ? (
										<Button variant="ghost" size="sm" onClick={() => void stop(item.id)}>
											<SquareIcon aria-hidden="true" className="size-3" /> Stop
										</Button>
									) : null}
								</div>
								<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed">
									{item.output || "(no output yet)"}
								</pre>
							</div>
						))
					)}
				</div>
			</ScrollArea>
		</div>
	)
}
