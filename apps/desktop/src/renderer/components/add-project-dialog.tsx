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
import { useAtomValue } from "jotai"
import { FolderOpenIcon, FolderPlusIcon, Loader2Icon } from "lucide-react"
import { useCallback, useState } from "react"
import { activeServerConfigAtom } from "../atoms/connection"
import { useI18n } from "../hooks/use-i18n"
import { createProjectDirectory } from "../services/backend"
import { addProject } from "../services/connection-manager"

interface AddProjectDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	onAdded?: (directory: string) => void
}

export function AddProjectDialog({ open, onOpenChange, onAdded }: AddProjectDialogProps) {
	const { t } = useI18n()
	const activeServer = useAtomValue(activeServerConfigAtom)
	const createsDirectory = activeServer.type === "local"
	const [value, setValue] = useState("")
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (nextOpen) {
				setValue("")
				setError(null)
				setLoading(false)
			}
			onOpenChange(nextOpen)
		},
		[onOpenChange],
	)

	const handleAdd = useCallback(async () => {
		const trimmed = value.trim()
		if (!trimmed) return

		setLoading(true)
		setError(null)
		try {
			const directory = createsDirectory ? (await createProjectDirectory(trimmed)).path : trimmed
			const project = await addProject(directory)
			onAdded?.(project.worktree)
			onOpenChange(false)
		} catch (err) {
			setError(err instanceof Error ? err.message : t("project.addFailed"))
		} finally {
			setLoading(false)
		}
	}, [createsDirectory, onAdded, onOpenChange, t, value])

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t(createsDirectory ? "project.createTitle" : "project.addTitle")}</DialogTitle>
					<DialogDescription>
						{t(createsDirectory ? "project.createDescription" : "project.addDescription")}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-4">
					<div className="space-y-2">
						<Label htmlFor={createsDirectory ? "project-name" : "project-path"}>
							{t(createsDirectory ? "project.name" : "project.path")}
						</Label>
						<div className="relative">
							{createsDirectory ? (
								<FolderPlusIcon
									aria-hidden="true"
									className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
								/>
							) : (
								<FolderOpenIcon
									aria-hidden="true"
									className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
								/>
							)}
							<Input
								id={createsDirectory ? "project-name" : "project-path"}
								placeholder={createsDirectory ? "my-project" : "C:\path\to\project"}
								value={value}
								onChange={(e) => {
									setValue(e.target.value)
									setError(null)
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter" && value.trim()) handleAdd()
								}}
								className="pl-9"
								autoFocus
							/>
						</div>
						<p className="text-xs text-muted-foreground">
							{t(createsDirectory ? "project.nameHint" : "project.pathHint")}
						</p>
					</div>

					{error ? (
						<div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
							{error}
						</div>
					) : null}
				</div>

				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>{t("common.cancel")}</DialogClose>
					<Button disabled={!value.trim() || loading} onClick={handleAdd}>
						{loading ? <Loader2Icon aria-hidden="true" className="size-3.5 animate-spin" /> : null}
						{t(createsDirectory ? "project.create" : "project.add")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
