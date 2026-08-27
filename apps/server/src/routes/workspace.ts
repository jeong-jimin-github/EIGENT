import { Hono } from "hono"
import {
	createWorkspaceDirectory,
	deleteWorkspacePath,
	listWorkspace,
	readWorkspaceText,
	renameWorkspacePath,
	writeWorkspaceText,
} from "../services/workspace-service"

function message(err: unknown) {
	return err instanceof Error ? err.message : "Workspace operation failed"
}

const app = new Hono()
	.get("/list", async (c) => {
		const root = c.req.query("root")
		const targetPath = c.req.query("path") ?? ""
		if (!root) return c.json({ error: "root is required" }, 400)
		try {
			return c.json({ entries: await listWorkspace(root, targetPath) }, 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.get("/read", async (c) => {
		const root = c.req.query("root")
		const targetPath = c.req.query("path")
		if (!root || !targetPath) return c.json({ error: "root and path are required" }, 400)
		try {
			return c.json(await readWorkspaceText(root, targetPath), 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.put("/write", async (c) => {
		const body = (await c.req.json()) as { root?: string; path?: string; content?: string }
		if (!body.root || !body.path || typeof body.content !== "string") {
			return c.json({ error: "root, path and content are required" }, 400)
		}
		try {
			return c.json(await writeWorkspaceText(body.root, body.path, body.content), 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.post("/mkdir", async (c) => {
		const body = (await c.req.json()) as { root?: string; path?: string }
		if (!body.root || !body.path) return c.json({ error: "root and path are required" }, 400)
		try {
			return c.json(await createWorkspaceDirectory(body.root, body.path), 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.post("/rename", async (c) => {
		const body = (await c.req.json()) as { root?: string; from?: string; to?: string }
		if (!body.root || !body.from || !body.to) {
			return c.json({ error: "root, from and to are required" }, 400)
		}
		try {
			return c.json(await renameWorkspacePath(body.root, body.from, body.to), 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.delete("/path", async (c) => {
		const body = (await c.req.json()) as { root?: string; path?: string }
		if (!body.root || !body.path) return c.json({ error: "root and path are required" }, 400)
		try {
			return c.json(await deleteWorkspacePath(body.root, body.path), 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})

export default app
