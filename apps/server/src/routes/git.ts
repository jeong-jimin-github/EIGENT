import { Hono } from "hono"
import {
	applyChangesToLocal,
	applyDiffTextToLocal,
	checkout,
	commitAll,
	createBranch,
	getDiffStat,
	getGitRoot,
	getRemoteUrl,
	getStatus,
	listBranches,
	push,
	stashAndCheckout,
	stashPop,
} from "../services/git-service"

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Git operation failed"
}

const app = new Hono()
	.get("/branches", async (c) => {
		const directory = c.req.query("directory")
		if (!directory) return c.json({ error: "directory is required" }, 400)
		try {
			return c.json(await listBranches(directory), 200)
		} catch (err) {
			return c.json({ error: errorMessage(err) }, 500)
		}
	})
	.get("/status", async (c) => {
		const directory = c.req.query("directory")
		if (!directory) return c.json({ error: "directory is required" }, 400)
		try {
			return c.json(await getStatus(directory), 200)
		} catch (err) {
			return c.json({ error: errorMessage(err) }, 500)
		}
	})
	.post("/checkout", async (c) => {
		const body = (await c.req.json()) as { directory?: string; branch?: string }
		if (!body.directory || !body.branch) {
			return c.json({ error: "directory and branch are required" }, 400)
		}
		return c.json(await checkout(body.directory, body.branch), 200)
	})
	.post("/stash-checkout", async (c) => {
		const body = (await c.req.json()) as { directory?: string; branch?: string }
		if (!body.directory || !body.branch) {
			return c.json({ error: "directory and branch are required" }, 400)
		}
		return c.json(await stashAndCheckout(body.directory, body.branch), 200)
	})
	.post("/stash-pop", async (c) => {
		const body = (await c.req.json()) as { directory?: string }
		if (!body.directory) return c.json({ error: "directory is required" }, 400)
		return c.json(await stashPop(body.directory), 200)
	})
	.get("/root", async (c) => {
		const directory = c.req.query("directory")
		if (!directory) return c.json({ error: "directory is required" }, 400)
		return c.json({ root: await getGitRoot(directory) }, 200)
	})
	.get("/diff-stat", async (c) => {
		const directory = c.req.query("directory")
		if (!directory) return c.json({ error: "directory is required" }, 400)
		try {
			return c.json(await getDiffStat(directory), 200)
		} catch (err) {
			return c.json({ error: errorMessage(err) }, 500)
		}
	})
	.post("/commit", async (c) => {
		const body = (await c.req.json()) as { directory?: string; message?: string }
		if (!body.directory || !body.message) {
			return c.json({ error: "directory and message are required" }, 400)
		}
		return c.json(await commitAll(body.directory, body.message), 200)
	})
	.post("/push", async (c) => {
		const body = (await c.req.json()) as { directory?: string; remote?: string }
		if (!body.directory) return c.json({ error: "directory is required" }, 400)
		return c.json(await push(body.directory, body.remote), 200)
	})
	.post("/branch", async (c) => {
		const body = (await c.req.json()) as { directory?: string; branchName?: string }
		if (!body.directory || !body.branchName) {
			return c.json({ error: "directory and branchName are required" }, 400)
		}
		return c.json(await createBranch(body.directory, body.branchName), 200)
	})
	.get("/remote-url", async (c) => {
		const directory = c.req.query("directory")
		const remote = c.req.query("remote")
		if (!directory) return c.json({ error: "directory is required" }, 400)
		return c.json({ url: await getRemoteUrl(directory, remote) }, 200)
	})
	.post("/apply-local", async (c) => {
		const body = (await c.req.json()) as { worktreeDir?: string; localDir?: string }
		if (!body.worktreeDir || !body.localDir) {
			return c.json({ error: "worktreeDir and localDir are required" }, 400)
		}
		return c.json(await applyChangesToLocal(body.worktreeDir, body.localDir), 200)
	})
	.post("/apply-diff", async (c) => {
		const body = (await c.req.json()) as { localDir?: string; diffText?: string }
		if (!body.localDir || typeof body.diffText !== "string") {
			return c.json({ error: "localDir and diffText are required" }, 400)
		}
		return c.json(await applyDiffTextToLocal(body.localDir, body.diffText), 200)
	})

export default app
