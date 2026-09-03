import { QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import { Provider as JotaiProvider } from "jotai"
import { appStore } from "./atoms/store"
import { BrowserHarness } from "./components/browser-harness"
import { LegacyI18nBridge } from "./components/legacy-i18n-bridge"
import { queryClient } from "./lib/query-client"
import { router } from "./router"

export function App() {
	return (
		<JotaiProvider store={appStore}>
			<QueryClientProvider client={queryClient}>
				<div className="flex h-screen h-dvh w-screen overflow-hidden">
					<div className="min-w-0 flex-1">
						<RouterProvider router={router} />
					</div>
					<BrowserHarness />
				</div>
				<LegacyI18nBridge />
			</QueryClientProvider>
		</JotaiProvider>
	)
}
