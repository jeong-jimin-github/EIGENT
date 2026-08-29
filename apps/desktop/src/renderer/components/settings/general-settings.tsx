import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@palot/ui/components/select"
import { Switch } from "@palot/ui/components/switch"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { type DisplayMode, displayModeAtom, opaqueWindowsAtom } from "../../atoms/preferences"
import { useI18n } from "../../hooks/use-i18n"
import { useColorScheme, useSetColorScheme } from "../../hooks/use-theme"
import {
	languagePreferenceAtom,
	type LanguagePreference,
} from "../../lib/i18n"
import type { ColorScheme } from "../../lib/themes"
import { fetchOpenInTargets, setOpenInPreferred } from "../../services/backend"
import { SettingsRow } from "./settings-row"
import { SettingsSection } from "./settings-section"

const isElectron = typeof window !== "undefined" && "palot" in window

export function GeneralSettings() {
	const { t } = useI18n()
	return (
		<div className="space-y-8">
			<div>
				<h2 className="text-xl font-semibold">{t("settings.general")}</h2>
			</div>

			<SettingsSection>
				<LanguageRow />
				<OpenDestinationRow />
			</SettingsSection>

			<SettingsSection title={t("settings.appearance")}>
				<ThemeRow />
				<OpaqueWindowsRow />
				<DisplayModeRow />
			</SettingsSection>
		</div>
	)
}

function LanguageRow() {
	const [language, setLanguage] = useAtom(languagePreferenceAtom)
	const { t } = useI18n()
	const items: Record<LanguagePreference, string> = {
		system: t("settings.system"),
		en: t("settings.english"),
		ko: t("settings.korean"),
	}

	return (
		<SettingsRow label={t("settings.language")} description={t("settings.languageDescription")}>
			<Select
				value={language}
				onValueChange={(value) => setLanguage(value as LanguagePreference)}
				items={items}
			>
				<SelectTrigger className="min-w-[140px]">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="system">{items.system}</SelectItem>
					<SelectItem value="en">{items.en}</SelectItem>
					<SelectItem value="ko">{items.ko}</SelectItem>
				</SelectContent>
			</Select>
		</SettingsRow>
	)
}

function OpenDestinationRow() {
	const { t } = useI18n()
	const [targets, setTargets] = useState<{ id: string; label: string; available: boolean }[]>([])
	const [preferred, setPreferred] = useState<string | null>(null)

	useEffect(() => {
		if (!isElectron) return
		fetchOpenInTargets().then((result) => {
			setTargets(result.targets.filter((target) => target.available))
			setPreferred(result.preferredTarget)
		})
	}, [])

	const handleChange = useCallback(async (value: string) => {
		setPreferred(value)
		await setOpenInPreferred(value)
	}, [])

	if (targets.length === 0) return null

	return (
		<SettingsRow
			label={t("settings.openDestination")}
			description={t("settings.openDestinationDescription")}
		>
			<Select
				value={preferred ?? undefined}
				onValueChange={(value) => {
					if (value !== null) handleChange(value)
				}}
			>
				<SelectTrigger className="min-w-[180px]">
					<SelectValue placeholder={t("settings.select")} />
				</SelectTrigger>
				<SelectContent>
					{targets.map((target) => (
						<SelectItem key={target.id} value={target.id}>
							{target.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</SettingsRow>
	)
}

function ThemeRow() {
	const colorScheme = useColorScheme()
	const setColorScheme = useSetColorScheme()
	const { t } = useI18n()
	const options: { value: ColorScheme; label: string; icon: typeof SunIcon }[] = [
		{ value: "light", label: t("settings.light"), icon: SunIcon },
		{ value: "dark", label: t("settings.dark"), icon: MoonIcon },
		{ value: "system", label: t("settings.system"), icon: MonitorIcon },
	]

	return (
		<SettingsRow label={t("settings.theme")} description={t("settings.themeDescription")}>
			<div className="flex items-center rounded-md border border-border">
				{options.map((option) => {
					const Icon = option.icon
					const isActive = colorScheme === option.value
					return (
						<button
							key={option.value}
							type="button"
							onClick={() => setColorScheme(option.value)}
							className={`flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors first:rounded-l-md last:rounded-r-md ${
								isActive
									? "bg-accent text-accent-foreground font-medium"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							<Icon aria-hidden="true" className="size-3.5" />
							{option.label}
						</button>
					)
				})}
			</div>
		</SettingsRow>
	)
}

function OpaqueWindowsRow() {
	const opaque = useAtomValue(opaqueWindowsAtom)
	const setOpaque = useSetAtom(opaqueWindowsAtom)
	const { t } = useI18n()

	const handleChange = useCallback(
		async (checked: boolean) => {
			setOpaque(checked)
			if (isElectron) {
				await window.palot.setOpaqueWindows(checked)
				window.palot.relaunch()
			}
		},
		[setOpaque],
	)

	return (
		<SettingsRow label={t("settings.opaque")} description={t("settings.opaqueDescription")}>
			<Switch checked={opaque} onCheckedChange={handleChange} />
		</SettingsRow>
	)
}

function DisplayModeRow() {
	const displayMode = useAtomValue(displayModeAtom)
	const setDisplayMode = useSetAtom(displayModeAtom)
	const { t } = useI18n()
	const items = {
		default: t("settings.default"),
		thinking: t("settings.fullThinking"),
		verbose: t("settings.verbose"),
	}

	return (
		<SettingsRow
			label={t("settings.displayMode")}
			description={t("settings.displayModeDescription")}
		>
			<Select
				value={displayMode}
				onValueChange={(value) => setDisplayMode(value as DisplayMode)}
				items={items}
			>
				<SelectTrigger className="min-w-[140px]">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="default">{items.default}</SelectItem>
					<SelectItem value="thinking">{items.thinking}</SelectItem>
					<SelectItem value="verbose">{items.verbose}</SelectItem>
				</SelectContent>
			</Select>
		</SettingsRow>
	)
}
