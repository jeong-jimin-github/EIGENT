import type { BrowserRuntimeStatus } from "./browser-runtime"
import type { DesktopRuntimeStatus } from "./desktop-runtime"

export function browserRuntimeReadyForRequests(status: BrowserRuntimeStatus): boolean {
	if (status.connected) return true
	return status.state === "idle" && Boolean(status.executablePath)
}

export function desktopRuntimeReadyForRequests(status: DesktopRuntimeStatus): boolean {
	if (!status.enabled) return true
	if (status.ready) return true
	return status.managed && status.state === "idle" && status.missingCommands.length === 0
}
export type ReadinessComponent = { ok: boolean }

export function readinessSummary(components: Record<string, ReadinessComponent>): {
	status: "ok" | "degraded"
	httpStatus: 200 | 503
} {
	const ready = Object.values(components).every((component) => component.ok)
	return ready ? { status: "ok", httpStatus: 200 } : { status: "degraded", httpStatus: 503 }
}
