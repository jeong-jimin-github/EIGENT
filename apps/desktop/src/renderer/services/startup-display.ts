import type { DiscoveryPhase } from "../atoms/discovery"

/**
 * The app shell may be mounted during discovery so it is ready to paint, but it
 * must stay visually hidden until discovery has actually completed. Error is
 * intentionally visible so recovery/settings controls remain reachable.
 */
export function isStartupContentVisible(phase: DiscoveryPhase): boolean {
	return phase === "ready" || phase === "error"
}

/** Full-screen startup surface. Keep an opaque background so half-loaded menus never bleed through. */
export const STARTUP_OVERLAY_BASE_CLASS =
	"fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background transition-opacity"
