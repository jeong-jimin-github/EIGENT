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
import { assertWorkspaceAllowed } from "../services/workspace-policy"

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Git operation failed"
}

function allowed(directory: string, label = "git directory"): string {
	return assertWorkspaceAllowed(directory, label)
}

const app = new Hono()
	.get("/branches", async (c) => {
		const directory = c.req.query("directory")
		if (!directory) return c.json({ error: "directory is required" }, 400)
		try {
			return c.json(await listBranches(allowed(directory)), 200)
		} catch (err) {
			return c.json({ error: errorMessage(err) }, 500)
		}
	})
	.get("/status", async (c) => {
		const directory = c.req.query("directory")
		if (!directory) return c.json({ error: "directory is required" }, 400)
		try {
			return c.json(await getStatus(allowed(directory)), 200)
		} catch (err) {
			return c.json({ error: errorMessage(err) }, 500)
		}
	})
	.post("/checkout", async (c) => {
		const body = (await c.req.json()) as { directory?: string; branch?: string }
		if (!body.directory || !body.branch) {
			return c.json({ error: "directory and branch are required" }, 400)
		}
		return c.json(await checkout(allowed(body.directory), body.branch), 200)
	})
	.post("/stash-checkout", async (c) => {
		const body = (await c.req.json()) as { directory?: string; branch?: string }
		if (!body.directory || !body.branch) {
			return c.json({ error: "directory and branch are required" }, 400)
		}
		return c.json(await stashAndCheckout(allowed(body.directory), body.branch), 200)
	})
	.post("/stash-pop", async (c) => {
		const body = (await c.req.json()) as { directory?: string }
		if (!body.directory) return c.json({ error: "directory is required" }, 400)
		return c.json(await stashPop(allowed(body.directory)), 200)
	})
	.get("/root", async (c) => {
		const directory = c.req.query("directory")
		if (!directory) return c.json({ error: "directory is required" }, 400)
		return c.json({ root: await getGitRoot(allowed(directory)) }, 200)
	})
	.get("/diff-stat", async (c) => {
		const directory = c.req.query("directory")
		if (!directory) return c.json({ error: "directory is required" }, 400)
		try {
			return c.json(await getDiffStat(allowed(directory)), 200)
		} catch (err) {
			return c.json({ error: errorMessage(err) }, 500)
		}
	})
	.post("/commit", async (c) => {
		const body = (await c.req.json()) as { directory?: string; message?: string }
		if (!body.directory || !body.message) {
			return c.json({ error: "directory and message are required" }, 400)
		}
		return c.json(await commitAll(allowed(body.directory), body.message), 200)
	})
	.post("/push", async (c) => {
		const body = (await c.req.json()) as { directory?: string; remote?: string }
		if (!body.directory) return c.json({ error: "directory is required" }, 400)
		return c.json(await push(allowed(body.directory), body.remote), 200)
	})
	.post("/branch", async (c) => {
		const body = (await c.req.json()) as { directory?: string; branchName?: string }
		if (!body.directory || !body.branchName) {
			return c.json({ error: "directory and branchName are required" }, 400)
		}
		return c.json(await createBranch(allowed(body.directory), body.branchName), 200)
	})
	.get("/remote-url", async (c) => {
		const directory = c.req.query("directory")
		const remote = c.req.query("remote")
		if (!directory) return c.json({ error: "directory is required" }, 400)
		return c.json({ url: await getRemoteUrl(allowed(directory), remote) }, 200)
	})
	.post("/apply-local", async (c) => {
		const body = (await c.req.json()) as { worktreeDir?: string; localDir?: string }
		if (!body.worktreeDir || !body.localDir) {
			return c.json({ error: "worktreeDir and localDir are required" }, 400)
		}
		return c.json(
			await applyChangesToLocal(
				allowed(body.worktreeDir, "worktree directory"),
				allowed(body.localDir, "local directory"),
			),
			200,
		)
	})
	.post("/apply-diff", async (c) => {
		const body = (await c.req.json()) as { localDir?: string; diffText?: string }
		if (!body.localDir || typeof body.diffText !== "string") {
			return c.json({ error: "localDir and diffText are required" }, 400)
		}
		return c.json(
			await applyDiffTextToLocal(allowed(body.localDir, "local directory"), body.diffText),
			200,
		)
	})

export default app
