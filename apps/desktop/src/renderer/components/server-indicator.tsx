import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@palot/ui/components/sidebar"
import { useAtomValue } from "jotai"
import { ServerIcon } from "lucide-react"
import { serverConnectedAtom } from "../atoms/connection"
import { useI18n } from "../hooks/use-i18n"

export function ServerIndicator() {
	const connected = useAtomValue(serverConnectedAtom)
	const { t } = useI18n()
	const status = connected ? t("server.connected") : t("server.offline")

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<SidebarMenuButton
					tooltip={`${t("server.name")}: ${status}`}
					className={
						connected
							? "text-muted-foreground hover:bg-transparent active:bg-transparent"
							: "text-red-500 hover:bg-transparent active:bg-transparent"
					}
				>
					<div className="relative">
						<ServerIcon aria-hidden="true" className="size-4" />
						<span
							className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-sidebar-background ${connected ? "bg-green-500" : "bg-red-500"}`}
						/>
					</div>
					<span className="truncate">{t("server.name")}</span>
					<span className={`text-[10px] ${connected ? "text-muted-foreground/70" : "text-red-500/70"}`}>
						{status}
					</span>
				</SidebarMenuButton>
			</SidebarMenuItem>
		</SidebarMenu>
	)
}
