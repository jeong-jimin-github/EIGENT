import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"
import "./index.css"

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
)


if (!window.palot && import.meta.env.PROD && "serviceWorker" in navigator) {
	window.addEventListener("load", () => {
		navigator.serviceWorker.register("/sw.js").catch(() => {
			// PWA is optional; app startup must not depend on registration.
		})
	})
}
