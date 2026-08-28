import path from "node:path"
import { Hono } from "hono"
import { agentRuns } from "../services/agent-runs"
import { providerRegistry } from "../services/provider-registry"
import { stateStore } from "../services/state"
import { assertWorkspaceAllowed } from "../services/workspace-policy"

function insideWorkspace(workspace: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(workspace), path.resolve(candidate))
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const app = new Hono().get("/", (c) => {
	const requestedWorkspace = c.req.query("workspace")
	if (!requestedWorkspace) return c.json({ error: "workspace is required" }, 400)
	let workspace: string
	try {
		workspace = assertWorkspaceAllowed(requestedWorkspace)
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
	}

	const sessions = providerRegistry.listSessions(workspace).map((session) => ({
		session,
		lastSequence: stateStore.getLastAgentEventSequence(session.id),
		activeRequestId: agentRuns.getActiveRequestId(session.id),
		running: agentRuns.isRunning(session.id),
	}))
	const processes = stateStore
		.listManagedProcesses()
		.filter((process) => insideWorkspace(workspace, process.cwd))

	return c.json(
		{
			schemaVersion: stateStore.getSchemaVersion(),
			generatedAt: Date.now(),
			workspace,
			tasks: stateStore.listTasks(workspace),
			sessions,
			processes,
		},
		200,
	)
})

export default app
