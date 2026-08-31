import { canonicalizePotentialPath, resolveWorkspaceScope } from "./workspace-policy"

export interface DevicePreviewReloadState {
	root: string
	revision: number
	requestedAt: number
}

const reloadStates = new Map<string, DevicePreviewReloadState>()

function canonicalWorkspaceRoot(root: string): string {
	return canonicalizePotentialPath(resolveWorkspaceScope(root, "preview reload root"))
}

export function getDevicePreviewReloadState(root: string): DevicePreviewReloadState {
	const resolvedRoot = canonicalWorkspaceRoot(root)
	return reloadStates.get(resolvedRoot) ?? { root: resolvedRoot, revision: 0, requestedAt: 0 }
}

export function requestDevicePreviewReload(root: string): DevicePreviewReloadState {
	const current = getDevicePreviewReloadState(root)
	const next = {
		root: current.root,
		revision: current.revision + 1,
		requestedAt: Date.now(),
	}
	reloadStates.set(current.root, next)
	return next
}
