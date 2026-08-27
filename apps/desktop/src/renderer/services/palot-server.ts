/**
 * Type-safe RPC client for the Palot local backend server (Bun + Hono).
 *
 * Uses Hono's RPC client (`hc`) with the server's AppType for end-to-end
 * type safety. The type is resolved from compiled declarations (.d.ts)
 * so the desktop app doesn't need Bun types.
 */

import { createClient } from "@palot/server/client"

const BASE_URL = typeof window === "undefined" ? "http://127.0.0.1:3100" : window.location.origin

/**
 * Pre-typed Hono RPC client.
 * All routes are fully typed — autocomplete on paths, inferred request/response types.
 */
export const client = createClient(BASE_URL)

/**
 * Fetches all running OpenCode servers (detected + managed).
 */
export async function fetchServers() {
	const res = await client.api.servers.$get()
	if (!res.ok) {
		throw new Error(`Server list failed: ${res.status} ${res.statusText}`)
	}
	return res.json()
}

/**
 * Ensures the single OpenCode server is running and returns its URL.
 * Calls `GET /api/servers/opencode` on the Palot backend.
 */
export async function fetchOpenCodeUrl(): Promise<{ url: string }> {
	const res = await client.api.servers.opencode.$get()
	if (!res.ok) {
		const data = await res.json()
		throw new Error("error" in data ? data.error : "Failed to get OpenCode server URL")
	}
	return res.json()
}

/**
 * Fetches the OpenCode model state (recent models, favorites, variants)
 * from the backend, which reads ~/.local/state/opencode/model.json.
 */
export async function fetchModelState(): Promise<{
	recent: { providerID: string; modelID: string }[]
	favorite: { providerID: string; modelID: string }[]
	variant: Record<string, string | undefined>
}> {
	const res = await client.api["model-state"].$get()
	if (!res.ok) {
		throw new Error(`Model state fetch failed: ${res.status} ${res.statusText}`)
	}
	return res.json()
}

/**
 * Updates the recent model list via the backend server.
 * Adds the model to the front, deduplicates, caps at 10.
 */
export async function updateModelRecent(model: { providerID: string; modelID: string }): Promise<{
	recent: { providerID: string; modelID: string }[]
	favorite: { providerID: string; modelID: string }[]
	variant: Record<string, string | undefined>
}> {
	const res = await client.api["model-state"].recent.$post({
		json: model,
	})
	if (!res.ok) {
		throw new Error(`Model state update failed: ${res.status} ${res.statusText}`)
	}
	return res.json()
}

/**
 * Checks if the Palot server is running.
 */
export async function checkServerHealth() {
	try {
		const res = await client.health.$get()
		return res.ok
	} catch {
		return false
	}
}

// ============================================================
// Git API — browser mode
// ============================================================

function gitError(status: number, statusText: string): Error {
	return new Error(`Git operation failed: ${status} ${statusText}`)
}

export async function fetchGitBranches(directory: string) {
	const res = await client.api.git.branches.$get({ query: { directory } })
	if (!res.ok) throw gitError(res.status, res.statusText)
	return res.json()
}

export async function fetchGitStatus(directory: string) {
	const res = await client.api.git.status.$get({ query: { directory } })
	if (!res.ok) throw gitError(res.status, res.statusText)
	return res.json()
}

export async function gitCheckout(directory: string, branch: string) {
	const res = await client.api.git.checkout.$post({ json: { directory, branch } })
	if (!res.ok) throw gitError(res.status, res.statusText)
	return res.json()
}

export async function gitStashAndCheckout(directory: string, branch: string) {
	const res = await client.api.git["stash-checkout"].$post({ json: { directory, branch } })
	if (!res.ok) throw gitError(res.status, res.statusText)
	return res.json()
}

export async function gitStashPop(directory: string) {
	const res = await client.api.git["stash-pop"].$post({ json: { directory } })
	if (!res.ok) throw gitError(res.status, res.statusText)
	return res.json()
}

export async function getGitRoot(directory: string) {
	const res = await client.api.git.root.$get({ query: { directory } })
	if (!res.ok) throw gitError(res.status, res.statusText)
	const data = await res.json()
	return data.root
}

export async function fetchDiffStat(directory: string) {
	const res = await client.api.git["diff-stat"].$get({ query: { directory } })
	if (!res.ok) throw gitError(res.status, res.statusText)
	return res.json()
}

export async function gitCommitAll(directory: string, message: string) {
	const res = await client.api.git.commit.$post({ json: { directory, message } })
	if (!res.ok) throw gitError(res.status, res.statusText)
	return res.json()
}

export async function gitPush(directory: string, remote?: string) {
	const res = await client.api.git.push.$post({ json: { directory, remote } })
	if (!res.ok) throw gitError(res.status, res.statusText)
	return res.json()
}

export async function gitCreateBranch(directory: string, branchName: string) {
	const res = await client.api.git.branch.$post({ json: { directory, branchName } })
	if (!res.ok) throw gitError(res.status, res.statusText)
	return res.json()
}

export async function getGitRemoteUrl(directory: string, remote?: string) {
	const query = remote ? { directory, remote } : { directory }
	const res = await client.api.git["remote-url"].$get({ query })
	if (!res.ok) throw gitError(res.status, res.statusText)
	const data = await res.json()
	return data.url
}

export async function gitApplyToLocal(worktreeDir: string, localDir: string) {
	const res = await client.api.git["apply-local"].$post({ json: { worktreeDir, localDir } })
	if (!res.ok) throw gitError(res.status, res.statusText)
	return res.json()
}

export async function gitApplyDiffText(localDir: string, diffText: string) {
	const res = await client.api.git["apply-diff"].$post({ json: { localDir, diffText } })
	if (!res.ok) throw gitError(res.status, res.statusText)
	return res.json()
}
