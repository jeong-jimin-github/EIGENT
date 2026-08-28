import { Button } from "@palot/ui/components/button"
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@palot/ui/components/dialog"
import { Input } from "@palot/ui/components/input"
import { Label } from "@palot/ui/components/label"
import { FolderOpenIcon, Loader2Icon } from "lucide-react"
import { useCallback, useState } from "react"
import { useI18n } from "../hooks/use-i18n"
import { addProject } from "../services/connection-manager"

interface AddProjectDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	onAdded?: (directory: string) => void
}

export function AddProjectDialog({ open, onOpenChange, onAdded }: AddProjectDialogProps) {
	const { t } = useI18n()
	const [directory, setDirectory] = useState("")
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (nextOpen) {
				setDirectory("")
				setError(null)
				setLoading(false)
			}
			onOpenChange(nextOpen)
		},
		[onOpenChange],
	)

	const handleAdd = useCallback(async () => {
		const trimmed = directory.trim()
		if (!trimmed) return

		setLoading(true)
		setError(null)
		try {
			const project = await addProject(trimmed)
			onAdded?.(project.worktree)
			onOpenChange(false)
		} catch (err) {
			setError(err instanceof Error ? err.message : t("project.addFailed"))
		} finally {
			setLoading(false)
		}
	}, [directory, onAdded, onOpenChange, t])

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("project.addTitle")}</DialogTitle>
					<DialogDescription>{t("project.addDescription")}</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-4">
					<div className="space-y-2">
						<Label htmlFor="project-path">{t("project.path")}</Label>
						<div className="relative">
							<FolderOpenIcon
								aria-hidden="true"
								className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
							/>
							<Input
								id="project-path"
								placeholder="C:\path\to\project"
								value={directory}
								onChange={(e) => {
									setDirectory(e.target.value)
									setError(null)
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" && directory.trim()) handleAdd()
								}}
								className="pl-9"
								autoFocus
							/>
						</div>
						<p className="text-xs text-muted-foreground">{t("project.pathHint")}</p>
					</div>

					{error && (
						<div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
							{error}
						</div>
					)}
				</div>

				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>{t("common.cancel")}</DialogClose>
					<Button disabled={!directory.trim() || loading} onClick={handleAdd}>
						{loading && <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" />}
						{t("project.add")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
