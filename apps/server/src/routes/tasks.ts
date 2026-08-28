import { Hono } from "hono"
import { stateStore } from "../services/state"
import type { PersistentTaskState } from "../services/state-store"
import { assertWorkspaceAllowed } from "../services/workspace-policy"

const TASK_STATES = new Set<PersistentTaskState>([
	"pending",
	"starting",
	"running",
	"waiting_input",
	"completed",
	"failed",
	"interrupted",
])

const app = new Hono()
	.get("/", (c) => {
		const requestedWorkspace = c.req.query("workspace")
		if (!requestedWorkspace) return c.json({ tasks: stateStore.listTasks() }, 200)
		try {
			const workspace = assertWorkspaceAllowed(requestedWorkspace)
			return c.json({ tasks: stateStore.listTasks(workspace) }, 200)
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
		}
	})
	.post("/", async (c) => {
		const body = (await c.req.json()) as { workspace?: string; title?: string }
		if (!body.workspace || !body.title?.trim()) {
			return c.json({ error: "workspace and title are required" }, 400)
		}
		try {
			const workspace = assertWorkspaceAllowed(body.workspace)
			return c.json(stateStore.createTask(workspace, body.title.trim()), 201)
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
		}
	})
	.get("/:id", (c) => {
		const task = stateStore.getTask(c.req.param("id"))
		return task ? c.json(task, 200) : c.json({ error: "task not found" }, 404)
	})
	.patch("/:id", async (c) => {
		const body = (await c.req.json()) as { title?: string; state?: PersistentTaskState }
		if (body.title !== undefined && !body.title.trim()) {
			return c.json({ error: "title cannot be empty" }, 400)
		}
		if (body.state !== undefined && !TASK_STATES.has(body.state)) {
			return c.json({ error: "invalid task state" }, 400)
		}
		if (body.title === undefined && body.state === undefined) {
			return c.json({ error: "title or state is required" }, 400)
		}
		const task = stateStore.updateTask(c.req.param("id"), {
			title: body.title?.trim(),
			state: body.state,
		})
		return task ? c.json(task, 200) : c.json({ error: "task not found" }, 404)
	})

export default app
