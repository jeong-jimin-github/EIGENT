import {
	SidebarContent,
	SidebarGroup,
	SidebarGroupContent,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@palot/ui/components/sidebar"
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router"
import { ArrowLeftIcon, BellIcon, GitForkIcon, PlugIcon, SettingsIcon } from "lucide-react"
import { useEffect } from "react"
import { useI18n } from "../../hooks/use-i18n"
import type { TranslationKey } from "../../lib/i18n"
import { useSetSidebarSlot } from "../sidebar-slot-context"

type SettingsTab = "general" | "notifications" | "providers" | "worktrees"

const tabs: { id: SettingsTab; labelKey: TranslationKey; icon: typeof SettingsIcon }[] = [
	{ id: "general", labelKey: "settings.general", icon: SettingsIcon },
	{ id: "notifications", labelKey: "settings.notifications", icon: BellIcon },
	{ id: "providers", labelKey: "settings.providers", icon: PlugIcon },
	{ id: "worktrees", labelKey: "settings.worktrees", icon: GitForkIcon },
]

export function SettingsPage() {
	const { setContent, setFooter } = useSetSidebarSlot()

	useEffect(() => {
		setContent(<SettingsSidebarContent />)
		setFooter(false)
		return () => {
			setContent(null)
			setFooter(null)
		}
	}, [setContent, setFooter])

	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto max-w-2xl px-8 py-6">
				<Outlet />
			</div>
		</div>
	)
}

function SettingsSidebarContent() {
	const navigate = useNavigate()
	const pathname = useRouterState({ select: (s) => s.location.pathname })
	const { t } = useI18n()
	const activeTab = pathname.split("/").pop() || "general"

	return (
		<SidebarContent>
			<SidebarGroup>
				<SidebarGroupContent>
					<div className="px-2 py-1">
						<button
							type="button"
							onClick={() => navigate({ to: "/" })}
							className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
						>
							<ArrowLeftIcon aria-hidden="true" className="size-4" />
							{t("settings.back")}
						</button>
					</div>
					<SidebarMenu>
						{tabs.map((tab) => {
							const Icon = tab.icon
							const label = t(tab.labelKey)
							return (
								<SidebarMenuItem key={tab.id}>
									<SidebarMenuButton
										isActive={activeTab === tab.id}
										onClick={() => navigate({ to: `/settings/${tab.id}` })}
										tooltip={label}
									>
										<Icon aria-hidden="true" className="size-4" />
										<span>{label}</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							)
						})}
					</SidebarMenu>
				</SidebarGroupContent>
			</SidebarGroup>
		</SidebarContent>
	)
}
