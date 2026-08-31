import { Button } from "@palot/ui/components/button"
import { Globe2Icon, PanelRightCloseIcon } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { BrowserLiveView } from "./browser-live-view"

interface BrowserStatus {
	connected: boolean
	tabs?: Array<{ id: string; url: string; title: string }>
}

export function BrowserHarness() {
	const [available, setAvailable] = useState(false)
	const [open, setOpen] = useState(false)
	const dismissedRef = useRef(false)

	const checkStatus = useCallback(async () => {
		try {
			const response = await fetch("/api/browser/status", { cache: "no-store" })
			if (!response.ok) return
			const status = (await response.json()) as BrowserStatus
			const nextAvailable = Boolean(status.connected && status.tabs && status.tabs.length > 0)
			setAvailable(nextAvailable)
			if (nextAvailable && !dismissedRef.current) setOpen(true)
		} catch {
			// The browser runtime is optional. Keep the chat usable while it is offline.
		}
	}, [])

	useEffect(() => {
		void checkStatus()
		const timer = window.setInterval(() => void checkStatus(), 2_000)
		return () => window.clearInterval(timer)
	}, [checkStatus])

	if (!open) {
		if (!available) return null
		return (
			<Button
				type="button"
				variant="outline"
				size="icon"
				className="fixed bottom-4 right-4 z-50 shadow-md"
				title="Show browser panel"
				onClick={() => {
					dismissedRef.current = false
					setOpen(true)
				}}
			>
				<Globe2Icon aria-hidden="true" className="size-4" />
				<span className="sr-only">Show browser panel</span>
			</Button>
		)
	}

	return (
		<aside className="relative z-20 hidden h-full w-[45vw] min-w-[420px] max-w-[760px] shrink-0 border-l border-border bg-background lg:block">
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className="absolute right-2 top-2 z-30 bg-background/80 backdrop-blur"
				title="Hide browser panel"
				onClick={() => {
					dismissedRef.current = true
					setOpen(false)
				}}
			>
				<PanelRightCloseIcon aria-hidden="true" className="size-4" />
				<span className="sr-only">Hide browser panel</span>
			</Button>
			<BrowserLiveView />
		</aside>
	)
}
