import { Button } from "@palot/ui/components/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@palot/ui/components/tooltip"
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router"
import { useAtomValue, useSetAtom } from "jotai"
import { WrenchIcon } from "lucide-react"
import { activePreviewContextAtom, projectToolsSessionAtom } from "../atoms/ui"
import { useI18n } from "../hooks/use-i18n"
import { useAppBarContent } from "./app-bar-context"

// Height of the app bar in pixels — used as CSS variable
export const APP_BAR_HEIGHT = 46

/**
 * Detect whether we're running inside Electron (preload injects `window.palot`).
 */
function isElectron(): boolean {
	return typeof window !== "undefined" && "palot" in window
}

export function AppBar() {
	const pageContent = useAppBarContent()
	const navigate = useNavigate()
	const { t } = useI18n()
	const projectToolsOpen = useRouterState({
		select: (state) => state.location.pathname.endsWith("/tools"),
	})
	const { projectSlug, sessionId } = useParams({ strict: false }) as {
		projectSlug?: string
		sessionId?: string
	}
	const activePreviewContext = useAtomValue(activePreviewContextAtom)
	const projectToolsSession = useAtomValue(projectToolsSessionAtom)
	const setProjectToolsSession = useSetAtom(projectToolsSessionAtom)

	return (
		<div
			data-slot="app-bar"
			className="relative z-30 flex shrink-0 items-center border-b border-border/50 pl-4 pr-3 transition-[padding-left] duration-250 ease-in-out group-data-[state=collapsed]/sidebar-wrapper:pl-[var(--window-controls-inset)]"
			style={{
				height: APP_BAR_HEIGHT,
				// Make entire bar draggable on Electron (title bar replacement)
				// @ts-expect-error -- vendor-prefixed CSS property
				WebkitAppRegion: isElectron() ? "drag" : undefined,
			}}
		>
			{/* ===== Page content (via portal) ===== */}
			<div className="relative flex h-full min-w-0 flex-1 items-center">{pageContent}</div>
			{projectSlug ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								variant="ghost"
								size="icon"
								className="size-7 shrink-0"
								aria-label={t(projectToolsOpen ? "sidebar.closeProjectTools" : "sidebar.projectTools")}
								onClick={() => {
									if (projectToolsOpen) {
										const returnSessionId =
											projectToolsSession?.projectSlug === projectSlug
												? projectToolsSession.sessionId
												: null
										if (returnSessionId) {
											navigate({
												to: "/project/$projectSlug/session/$sessionId",
												params: { projectSlug, sessionId: returnSessionId },
											})
										} else {
											navigate({ to: "/project/$projectSlug", params: { projectSlug } })
										}
										return
									}
									const rememberedSessionId = sessionId ?? null
									setProjectToolsSession({
										projectSlug,
										sessionId: rememberedSessionId ?? null,
										previewContext:
											activePreviewContext?.sessionId === rememberedSessionId ? activePreviewContext : null,
									})
									navigate({ to: "/project/$projectSlug/tools", params: { projectSlug } })
								}}
							/>
						}
					>
						<WrenchIcon aria-hidden="true" className="size-3.5" />
					</TooltipTrigger>
					<TooltipContent>
						{t(projectToolsOpen ? "sidebar.closeProjectTools" : "sidebar.projectTools")}
					</TooltipContent>
				</Tooltip>
			) : null}
		</div>
	)
}
