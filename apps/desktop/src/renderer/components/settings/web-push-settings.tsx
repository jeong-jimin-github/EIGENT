import { Switch } from "@palot/ui/components/switch"
import { useCallback, useEffect, useState } from "react"
import {
	fetchWebPushConfig,
	getWebPushSubscription,
	loadWebPushCategories,
	subscribeWebPush,
	supportsWebPush,
	unsubscribeWebPush,
	updateWebPushCategories,
	type WebPushCategories,
} from "../../services/web-push"
import { SettingsRow } from "./settings-row"
import { SettingsSection } from "./settings-section"

export function WebPushSettings() {
	const [categories, setCategories] = useState(loadWebPushCategories)
	const [subscribed, setSubscribed] = useState(false)
	const [supported] = useState(supportsWebPush)
	const [serverEnabled, setServerEnabled] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		if (!supported) return
		try {
			const [config, subscription] = await Promise.all([
				fetchWebPushConfig(),
				getWebPushSubscription(),
			])
			setServerEnabled(config.enabled)
			setSubscribed(Boolean(subscription))
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		}
	}, [supported])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const toggleSubscription = async (value: boolean) => {
		setBusy(true)
		setError(null)
		try {
			if (value) await subscribeWebPush(categories)
			else await unsubscribeWebPush()
			setSubscribed(value)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}

	const updateCategory = async (key: keyof WebPushCategories, value: boolean) => {
		const next = { ...categories, [key]: value }
		setCategories(next)
		setError(null)
		try {
			await updateWebPushCategories(next)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		}
	}

	const description = !supported
		? "This browser does not support PWA Web Push"
		: !serverEnabled
			? "Set EIGENT_VAPID_PUBLIC_KEY and EIGENT_VAPID_PRIVATE_KEY on the server"
			: subscribed
				? "Background notifications are enabled for this browser"
				: "Notify this browser while EIGENT is in the background or closed"

	return (
		<div className="space-y-8">
			<div>
				<h2 className="text-xl font-semibold">Notifications</h2>
				{error && <p className="mt-2 text-sm text-destructive">{error}</p>}
			</div>
			<SettingsSection>
				<SettingsRow label="Web Push" description={description}>
					<Switch checked={subscribed} disabled={!supported || !serverEnabled || busy} onCheckedChange={(value) => void toggleSubscription(value)} />
				</SettingsRow>
				<SettingsRow label="Completion notifications" description="Notify when a background task finishes">
					<Switch checked={categories.completion} disabled={!subscribed} onCheckedChange={(value) => void updateCategory("completion", value)} />
				</SettingsRow>
				<SettingsRow label="Failure notifications" description="Notify when an agent run fails">
					<Switch checked={categories.failure} disabled={!subscribed} onCheckedChange={(value) => void updateCategory("failure", value)} />
				</SettingsRow>
				<SettingsRow label="Permission notifications" description="Notify when an agent needs approval">
					<Switch checked={categories.permission} disabled={!subscribed} onCheckedChange={(value) => void updateCategory("permission", value)} />
				</SettingsRow>
				<SettingsRow label="Question notifications" description="Notify when an agent needs an answer">
					<Switch checked={categories.question} disabled={!subscribed} onCheckedChange={(value) => void updateCategory("question", value)} />
				</SettingsRow>
				<SettingsRow label="Reconnect warnings" description="Notify after repeated server reconnect failures">
					<Switch checked={categories.reconnect} disabled={!subscribed} onCheckedChange={(value) => void updateCategory("reconnect", value)} />
				</SettingsRow>
			</SettingsSection>
		</div>
	)
}
