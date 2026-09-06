import { Hono } from "hono"
import {
	getDevicePreviewReloadState,
	requestDevicePreviewReload,
} from "../services/device-preview-control"
import { createLoopbackPreviewSession } from "../services/loopback-preview"
import {
	clearSessionPreview,
	getSessionPreview,
	reloadSessionPreview,
	setSessionPreview,
} from "../services/session-preview"
import { resolveWorkspaceScope } from "../services/workspace-policy"
import {
	createWorkspacePreviewSession,
	findWorkspacePreviewEntry,
} from "../services/workspace-preview"
import {
	createProjectDirectory,
	createWorkspaceDirectory,
	deleteWorkspacePath,
	listManagedProjects,
	listWorkspace,
	readWorkspaceText,
	renameWorkspacePath,
	writeWorkspaceText,
} from "../services/workspace-service"

function message(err: unknown) {
	return err instanceof Error ? err.message : "Workspace operation failed"
}

const app = new Hono()
	.get("/resolve", (c) => {
		try {
			return c.json({ root: resolveWorkspaceScope(c.req.query("root"), "workspace root") }, 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.get("/preview-entry", async (c) => {
		try {
			const root = c.req.query("root") ?? ""
			return c.json({ entryPath: await findWorkspacePreviewEntry(root) }, 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.post("/preview-token", async (c) => {
		const body = (await c.req.json()) as {
			root?: string
			changedFiles?: string[]
			entryPath?: string
		}
		if (typeof body.root !== "string") return c.json({ error: "root is required" }, 400)
		try {
			const changedFiles = Array.isArray(body.changedFiles)
				? body.changedFiles.filter((file): file is string => typeof file === "string").slice(0, 500)
				: []
			const entryPath = typeof body.entryPath === "string" ? body.entryPath : undefined
			return c.json(await createWorkspacePreviewSession(body.root, changedFiles, entryPath), 201)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.get("/session-preview", (c) => {
		const sessionId = c.req.query("sessionId")
		if (!sessionId) return c.json({ error: "sessionId is required" }, 400)
		try {
			return c.json({ preview: getSessionPreview(sessionId) }, 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.post("/session-preview", async (c) => {
		const body = (await c.req.json()) as {
			sessionId?: string
			root?: string
			kind?: "workspace" | "loopback"
			path?: string
			url?: string
		}
		if (typeof body.sessionId !== "string" || typeof body.root !== "string") {
			return c.json({ error: "sessionId and root are required" }, 400)
		}
		try {
			if (body.kind === "workspace" && typeof body.path === "string") {
				return c.json(
					await setSessionPreview({
						sessionId: body.sessionId,
						root: body.root,
						kind: "workspace",
						path: body.path,
					}),
					200,
				)
			}
			if (body.kind === "loopback" && typeof body.url === "string") {
				return c.json(
					await setSessionPreview({
						sessionId: body.sessionId,
						root: body.root,
						kind: "loopback",
						url: body.url,
					}),
					200,
				)
			}
			return c.json({ error: "kind and matching path/url are required" }, 400)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.post("/session-preview/reload", async (c) => {
		const body = (await c.req.json()) as { sessionId?: string }
		if (typeof body.sessionId !== "string") return c.json({ error: "sessionId is required" }, 400)
		try {
			return c.json(reloadSessionPreview(body.sessionId), 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.post("/session-preview/loopback-token", async (c) => {
		const body = (await c.req.json()) as { sessionId?: string }
		if (typeof body.sessionId !== "string") return c.json({ error: "sessionId is required" }, 400)
		try {
			const preview = getSessionPreview(body.sessionId)
			if (!preview || preview.kind !== "loopback") {
				return c.json({ error: "session loopback preview is not active" }, 404)
			}
			return c.json(createLoopbackPreviewSession(preview.url), 201)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.delete("/session-preview", async (c) => {
		const body = (await c.req.json()) as { sessionId?: string }
		if (typeof body.sessionId !== "string") return c.json({ error: "sessionId is required" }, 400)
		try {
			return c.json({ cleared: clearSessionPreview(body.sessionId) }, 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.get("/preview-reload", (c) => {
		const root = c.req.query("root")
		if (root === undefined) return c.json({ error: "root is required" }, 400)
		try {
			return c.json(getDevicePreviewReloadState(root), 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.post("/preview-reload", async (c) => {
		const body = (await c.req.json()) as { root?: string }
		if (typeof body.root !== "string") return c.json({ error: "root is required" }, 400)
		try {
			return c.json(requestDevicePreviewReload(body.root), 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.post("/project", async (c) => {
		const body = (await c.req.json()) as { name?: string }
		if (!body.name) return c.json({ error: "name is required" }, 400)
		try {
			return c.json(await createProjectDirectory(body.name), 201)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.get("/projects", async (c) => {
		try {
			return c.json({ projects: await listManagedProjects() }, 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.get("/list", async (c) => {
		const root = c.req.query("root")
		const targetPath = c.req.query("path") ?? ""
		if (root === undefined) return c.json({ error: "root is required" }, 400)
		try {
			return c.json({ entries: await listWorkspace(root, targetPath) }, 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.get("/read", async (c) => {
		const root = c.req.query("root")
		const targetPath = c.req.query("path")
		if (root === undefined || !targetPath)
			return c.json({ error: "root and path are required" }, 400)
		try {
			return c.json(await readWorkspaceText(root, targetPath), 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.put("/write", async (c) => {
		const body = (await c.req.json()) as { root?: string; path?: string; content?: string }
		if (typeof body.root !== "string" || !body.path || typeof body.content !== "string") {
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
		if (typeof body.root !== "string" || !body.path) {
			return c.json({ error: "root and path are required" }, 400)
		}
		try {
			return c.json(await createWorkspaceDirectory(body.root, body.path), 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})
	.post("/rename", async (c) => {
		const body = (await c.req.json()) as { root?: string; from?: string; to?: string }
		if (typeof body.root !== "string" || !body.from || !body.to) {
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
		if (typeof body.root !== "string" || !body.path) {
			return c.json({ error: "root and path are required" }, 400)
		}
		try {
			return c.json(await deleteWorkspacePath(body.root, body.path), 200)
		} catch (err) {
			return c.json({ error: message(err) }, 400)
		}
	})

export default app
