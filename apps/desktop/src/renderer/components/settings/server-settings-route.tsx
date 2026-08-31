import { Button } from "@palot/ui/components/button"
import { CircleAlertIcon, DownloadIcon, Loader2Icon, SaveIcon, UploadIcon } from "lucide-react"
import { useCallback, useRef, useState } from "react"
import { useI18n } from "../../hooks/use-i18n"
import { ServerSettings } from "./server-settings"
import { SettingsRow } from "./settings-row"
import { SettingsSection } from "./settings-section"

const isElectron = typeof window !== "undefined" && "palot" in window

export function ServerSettingsRoute() {
	if (isElectron) return <ServerSettings />
	return <WebServerSettings />
}

function WebServerSettings() {
	const { language } = useI18n()
	const ko = language === "ko"
	const fileInputRef = useRef<HTMLInputElement>(null)
	const [busy, setBusy] = useState<"export" | "import" | null>(null)
	const [status, setStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null)

	const handleExport = useCallback(async () => {
		setBusy("export")
		setStatus(null)
		try {
			const response = await fetch("/api/servers/backup/export", { cache: "no-store" })
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { error?: string } | null
				throw new Error(body?.error ?? (ko ? "백업 내보내기에 실패했습니다." : "Backup export failed."))
			}
			const blob = await response.blob()
			const url = URL.createObjectURL(blob)
			const anchor = document.createElement("a")
			anchor.href = url
			anchor.download = `eigent-server-backup-${new Date().toISOString().slice(0, 10)}.json`
			document.body.appendChild(anchor)
			anchor.click()
			anchor.remove()
			URL.revokeObjectURL(url)
			setStatus({ kind: "success", message: ko ? "백업 파일을 다운로드했습니다." : "Backup downloaded." })
		} catch (error) {
			setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) })
		} finally {
			setBusy(null)
		}
	}, [ko])

	const handleFile = useCallback(async (file: File) => {
		setBusy("import")
		setStatus(null)
		try {
			const response = await fetch("/api/servers/backup/import", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: await file.text(),
			})
			const result = (await response.json()) as { success?: boolean; error?: string; sessionCount?: number }
			if (!response.ok || !result.success) {
				throw new Error(result.error ?? (ko ? "백업 가져오기에 실패했습니다." : "Backup import failed."))
			}
			setStatus({
				kind: "success",
				message: ko
					? `백업을 가져왔습니다. 세션 ${result.sessionCount ?? 0}개를 복원했습니다.`
					: `Backup imported. Restored ${result.sessionCount ?? 0} session(s).`,
			})
		} catch (error) {
			setStatus({ kind: "error", message: error instanceof Error ? error.message : String(error) })
		} finally {
			setBusy(null)
			if (fileInputRef.current) fileInputRef.current.value = ""
		}
	}, [ko])

	return (
		<div className="space-y-8">
			<input
				ref={fileInputRef}
				type="file"
				accept="application/json,.json"
				className="hidden"
				onChange={(event) => {
					const file = event.target.files?.[0]
					if (file) void handleFile(file)
				}}
			/>

			<div>
				<h2 className="text-xl font-semibold">{ko ? "서버" : "Server"}</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					{ko
						? "이 웹 앱은 현재 셀프호스팅 EIGENT 서버에 연결되어 있습니다."
						: "This web app is connected to the current self-hosted EIGENT server."}
				</p>
			</div>

			<div>
				<h3 className="flex items-center gap-2 text-base font-semibold">
					<SaveIcon aria-hidden="true" className="size-4" />
					{ko ? "백업 및 복원" : "Backup & Restore"}
				</h3>
				<p className="mt-1 text-sm text-muted-foreground">
					{ko
						? "OpenCode 인증 정보와 채팅 세션을 다른 EIGENT 환경으로 옮깁니다."
						: "Move OpenCode authentication and chat sessions between EIGENT environments."}
				</p>
				<p className="mt-2 flex max-w-2xl items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
					<CircleAlertIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
					<span>
						{ko
							? "백업에는 프로바이더 인증 정보와 전체 채팅 기록이 포함됩니다. 안전하게 보관하고 신뢰할 수 있는 파일만 가져오세요."
							: "Backups contain provider authentication and full chat transcripts. Store them securely and only import files you trust."}
					</span>
				</p>
			</div>

			<SettingsSection>
				<SettingsRow
					label={ko ? "백업 내보내기" : "Export backup"}
					description={ko ? "인증 정보와 세션을 하나의 JSON 파일로 저장합니다." : "Save authentication and sessions to one JSON file."}
				>
					<Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void handleExport()}>
						{busy === "export" ? <Loader2Icon className="size-3.5 animate-spin" /> : <DownloadIcon className="size-3.5" />}
						{ko ? "내보내기" : "Export"}
					</Button>
				</SettingsRow>
				<SettingsRow
					label={ko ? "백업 가져오기" : "Import backup"}
					description={ko ? "EIGENT 백업에서 인증 정보와 세션을 복원합니다." : "Restore authentication and sessions from an EIGENT backup."}
				>
					<Button variant="outline" size="sm" disabled={busy !== null} onClick={() => fileInputRef.current?.click()}>
						{busy === "import" ? <Loader2Icon className="size-3.5 animate-spin" /> : <UploadIcon className="size-3.5" />}
						{ko ? "가져오기" : "Import"}
					</Button>
				</SettingsRow>
			</SettingsSection>

			{status ? (
				<p className={status.kind === "success" ? "text-sm text-green-600 dark:text-green-400" : "text-sm text-destructive"}>
					{status.message}
				</p>
			) : null}
		</div>
	)
}
