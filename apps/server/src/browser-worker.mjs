import http from "node:http"
import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { chromium } from "playwright-core"

const cdpUrl = process.env.EIGENT_BROWSER_CDP_URL ?? "http://127.0.0.1:9223"
const port = Number(process.env.EIGENT_BROWSER_WORKER_PORT ?? 9224)
const downloadDir = path.resolve(process.env.EIGENT_BROWSER_DOWNLOAD_DIR ?? "./downloads")
const uploadDir = path.resolve(process.env.EIGENT_BROWSER_UPLOAD_DIR ?? "./uploads")
mkdirSync(downloadDir, { recursive: true })
mkdirSync(uploadDir, { recursive: true })

let browser
let context
let nextPageId = 1
const pageIds = new WeakMap()
const pagesById = new Map()
const dialogs = new Map()
const pageLocks = new Map()

function preparePage(page) {
	let id = pageIds.get(page)
	if (id) return id
	id = `tab-${nextPageId++}`
	pageIds.set(page, id)
	pagesById.set(id, page)
	page.on("close", () => {
		pagesById.delete(id)
		dialogs.delete(id)
		pageLocks.delete(id)
	})
	page.on("dialog", (dialog) => {
		dialogs.set(id, {
			dialog,
			type: dialog.type(),
			message: dialog.message(),
			defaultValue: dialog.defaultValue(),
		})
	})
	return id
}

async function ensureConnected() {
	if (browser?.isConnected() && context) return context
	browser = await chromium.connectOverCDP(cdpUrl, { timeout: 10_000 })
	browser.on("disconnected", () => { browser = undefined; context = undefined })
	context = browser.contexts()[0]
	if (!context) throw new Error("CDP browser did not expose a persistent context")
	for (const page of context.pages()) preparePage(page)
	context.on("page", preparePage)
	if (context.pages().length === 0) preparePage(await context.newPage())
	return context
}

async function listTabs() {
	await ensureConnected()
	return Promise.all(context.pages().map(async (page) => ({
		id: preparePage(page),
		url: page.url(),
		title: await page.title().catch(() => ""),
	})))
}

async function getPage(pageId) {
	await ensureConnected()
	if (pageId) {
		const page = pagesById.get(pageId)
		if (!page || page.isClosed()) throw new Error(`Unknown browser tab: ${pageId}`)
		return page
	}
	const pages = context.pages()
	const page = pages.at(-1) ?? await context.newPage()
	preparePage(page)
	return page
}

async function withPageLock(pageId, action) {
	const page = await getPage(pageId)
	const id = preparePage(page)
	if (dialogs.has(id)) throw new Error(`Pending dialog on ${id}; handle it with browser_dialog first`)
	const previous = pageLocks.get(id) ?? Promise.resolve()
	let release
	const gate = new Promise((resolve) => { release = resolve })
	const queued = previous.then(() => gate)
	pageLocks.set(id, queued)
	await previous
	try { return await action(page) }
	finally {
		release()
		if (pageLocks.get(id) === queued) pageLocks.delete(id)
	}
}

function clipped(value, maxChars = 30_000) {
	const limit = Math.max(100, Math.min(maxChars ?? 30_000, 200_000))
	return value.length > limit ? `${value.slice(0, limit)}\n…[truncated ${value.length - limit} chars]` : value
}
async function summary(page) {
	return { url: page.url(), title: await page.title().catch(() => "") }
}

async function runWithDialogSignal(page, action) {
	const id = preparePage(page)
	let onDialog
	const dialogSignal = new Promise((resolve) => {
		onDialog = (dialog) => resolve({ kind: "dialog", dialog })
		page.once("dialog", onDialog)
	})
	const actionPromise = Promise.resolve()
		.then(action)
		.then((value) => ({ kind: "done", value }), (error) => ({ kind: "error", error }))
	const outcome = await Promise.race([actionPromise, dialogSignal])
	if (outcome.kind === "dialog") {
		const pending = dialogs.get(id)
		if (pending) pending.actionDone = actionPromise
		return {
			url: page.url(),
			dialogPending: {
				type: outcome.dialog.type(),
				message: outcome.dialog.message(),
				defaultValue: outcome.dialog.defaultValue(),
			},
		}
	}
	page.off("dialog", onDialog)
	if (outcome.kind === "error") throw outcome.error
	return outcome.value
}
function uploadPath(input) {
	return path.isAbsolute(input) ? path.resolve(input) : path.resolve(uploadDir, input)
}
function downloadPath(filename) {
	return path.join(downloadDir, path.basename(filename))
}

async function execute(input) {
	switch (input.action) {
		case "tabs": return { tabs: await listTabs() }
		case "new_tab": {
			const ctx = await ensureConnected()
			const page = await ctx.newPage()
			const id = preparePage(page)
			if (input.url && input.url !== "about:blank") await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 })
			return { id, ...(await summary(page)) }
		}
		case "close_tab": {
			await (await getPage(input.pageId)).close()
			return { closed: true, pageId: input.pageId }
		}
		case "navigate": return withPageLock(input.pageId, async (page) => runWithDialogSignal(page, async () => {
			await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 })
			return summary(page)
		}))
		case "inspect": return withPageLock(input.pageId, async (page) => {
			const locator = input.selector ? page.locator(input.selector).first() : page.locator("html")
			const content = input.mode === "html"
				? await locator.evaluate((element) => element.outerHTML)
				: await (input.selector ? locator.innerText() : page.locator("body").innerText())
			return { ...(await summary(page)), content: clipped(content, input.maxChars) }
		})
		case "click": return withPageLock(input.pageId, async (page) => runWithDialogSignal(page, async () => {
			await page.locator(input.selector).first().click({ timeout: 15_000 })
			return summary(page)
		}))
		case "type": return withPageLock(input.pageId, async (page) => runWithDialogSignal(page, async () => {
			const locator = page.locator(input.selector).first()
			if (input.append) await locator.pressSequentially(input.text)
			else await locator.fill(input.text)
			if (input.pressEnter) await locator.press("Enter")
			return summary(page)
		}))
		case "select": return withPageLock(input.pageId, async (page) => runWithDialogSignal(page, async () => {
			const selected = await page.locator(input.selector).first().selectOption(input.values)
			return { selected, ...(await summary(page)) }
		}))
		case "upload": return withPageLock(input.pageId, async (page) => {
			const files = input.files.map(uploadPath)
			for (const file of files) if (!existsSync(file)) throw new Error(`Upload file does not exist: ${file}`)
			await page.locator(input.selector).first().setInputFiles(files)
			return { files, ...(await summary(page)) }
		})
		case "download": return withPageLock(input.pageId, async (page) => {
			const downloadPromise = page.waitForEvent("download", { timeout: 30_000 })
			await page.locator(input.selector).first().click({ timeout: 15_000 })
			const download = await downloadPromise
			const target = downloadPath(input.filename ?? download.suggestedFilename())
			await download.saveAs(target)
			return { path: target, suggestedFilename: download.suggestedFilename() }
		})
		case "screenshot": return withPageLock(input.pageId, async (page) => {
			const image = input.selector
				? await page.locator(input.selector).first().screenshot({ type: "png" })
				: await page.screenshot({ type: "png", fullPage: input.fullPage ?? false })
			return { ...(await summary(page)), mimeType: "image/png", base64: image.toString("base64") }
		})
		case "storage": return withPageLock(input.pageId, async (page) => ({
			...(await summary(page)),
			localStorage: await page.evaluate(() => Object.fromEntries(Object.entries(localStorage))),
			cookies: await page.context().cookies(page.url()),
		}))
		case "dialog_status": {
			const pending = dialogs.get(input.pageId)
			return { pageId: input.pageId, dialog: pending ? {
				type: pending.type, message: pending.message, defaultValue: pending.defaultValue,
			} : null }
		}
		case "dialog": {
			const pending = dialogs.get(input.pageId)
			if (!pending) throw new Error(`No pending dialog for ${input.pageId}`)
			dialogs.delete(input.pageId)
			if (input.accept) await pending.dialog.accept(input.promptText)
			else await pending.dialog.dismiss()
			if (pending.actionDone) {
				const settled = await pending.actionDone
				if (settled.kind === "error") throw settled.error
			}
			return { handled: true, pageId: input.pageId, accepted: input.accept }
		}
		default: throw new Error(`Unknown browser action: ${input.action}`)
	}
}

async function readJson(request) {
	let raw = ""
	for await (const chunk of request) {
		raw += chunk
		if (raw.length > 2_000_000) throw new Error("Request body too large")
	}
	return raw ? JSON.parse(raw) : {}
}
function send(response, status, body) {
	const data = JSON.stringify(body)
	response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) })
	response.end(data)
}

const server = http.createServer(async (request, response) => {
	try {
		if (request.method === "GET" && request.url === "/health") {
			await ensureConnected()
			return send(response, 200, { service: "eigent-browser-worker", ok: true, pid: process.pid })
		}
		if (request.method === "GET" && request.url === "/status") {
			return send(response, 200, {
				service: "eigent-browser-worker",
				pid: process.pid,
				connected: Boolean(browser?.isConnected()),
				tabs: await listTabs(),
			})
		}
		if (request.method === "POST" && request.url === "/action") {
			const input = await readJson(request)
			return send(response, 200, { result: await execute(input) })
		}
		return send(response, 404, { error: "Not found" })
	} catch (error) {
		return send(response, 400, { error: error instanceof Error ? error.message : String(error) })
	}
})

server.listen(port, "127.0.0.1")
