import { Hono } from "hono"
import {
	clearFinishedProcesses,
	getManagedProcess,
	HOSTNAME,
	killManagedProcess,
	listManagedProcesses,
	startManagedProcess,
	writeManagedProcess,
} from "../services/process-manager"

const app = new Hono()
	.get("/", (c) => c.json({ hostname: HOSTNAME, processes: listManagedProcesses() }, 200))
	.post("/", async (c) => {
		const body = (await c.req.json()) as { command?: string; cwd?: string }
		if (!body.command?.trim() || !body.cwd) {
			return c.json({ error: "command and cwd are required" }, 400)
		}
		return c.json(startManagedProcess(body.command, body.cwd), 201)
	})
	.get("/:id", (c) => {
		const info = getManagedProcess(c.req.param("id"))
		return info ? c.json(info, 200) : c.json({ error: "process not found" }, 404)
	})
	.post("/:id/stdin", async (c) => {
		const body = (await c.req.json()) as { input?: string }
		if (typeof body.input !== "string") return c.json({ error: "input is required" }, 400)
		return writeManagedProcess(c.req.param("id"), body.input)
			? c.json({ written: true }, 200)
			: c.json({ error: "process is not running" }, 409)
	})
	.post("/:id/kill", (c) =>
		killManagedProcess(c.req.param("id"))
			? c.json({ killed: true }, 200)
			: c.json({ error: "process is not running" }, 409),
	)
	.delete("/finished", (c) => c.json({ removed: clearFinishedProcesses() }, 200))

export default app
