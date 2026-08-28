import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { browserRuntime } from "./services/browser-runtime"
import { executeBrowserAction } from "./services/browser-tools"

const server = new McpServer({ name: "eigent-browser", version: "0.1.0" })
const textResult = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
})

server.registerTool(
	"browser_status",
	{
		description: "Get persistent EIGENT browser daemon status and tabs.",
	},
	async () => textResult(await browserRuntime.status()),
)

server.registerTool(
	"browser_tabs",
	{
		description: "List tabs in the shared persistent browser profile.",
	},
	async () => textResult(await executeBrowserAction({ action: "tabs" })),
)

server.registerTool(
	"browser_new_tab",
	{
		description: "Open a new shared browser tab.",
		inputSchema: { url: z.string().optional() },
	},
	async ({ url }) => textResult(await executeBrowserAction({ action: "new_tab", url })),
)

server.registerTool(
	"browser_close_tab",
	{
		description: "Close a browser tab.",
		inputSchema: { pageId: z.string() },
	},
	async ({ pageId }) => textResult(await executeBrowserAction({ action: "close_tab", pageId })),
)

server.registerTool(
	"browser_navigate",
	{
		description: "Navigate a persistent browser tab to a URL.",
		inputSchema: { pageId: z.string().optional(), url: z.string() },
	},
	async ({ pageId, url }) =>
		textResult(await executeBrowserAction({ action: "navigate", pageId, url })),
)

server.registerTool(
	"browser_inspect",
	{
		description: "Inspect visible text or HTML from the page or a selector.",
		inputSchema: {
			pageId: z.string().optional(),
			selector: z.string().optional(),
			mode: z.enum(["text", "html"]).optional(),
			maxChars: z.number().int().positive().max(200_000).optional(),
		},
	},
	async (args) => textResult(await executeBrowserAction({ action: "inspect", ...args })),
)

server.registerTool(
	"browser_click",
	{
		description: "Click the first element matching a Playwright selector.",
		inputSchema: { pageId: z.string().optional(), selector: z.string() },
	},
	async (args) => textResult(await executeBrowserAction({ action: "click", ...args })),
)

server.registerTool(
	"browser_type",
	{
		description: "Fill or append text to an input and optionally press Enter.",
		inputSchema: {
			pageId: z.string().optional(),
			selector: z.string(),
			text: z.string(),
			append: z.boolean().optional(),
			pressEnter: z.boolean().optional(),
		},
	},
	async (args) => textResult(await executeBrowserAction({ action: "type", ...args })),
)

server.registerTool(
	"browser_select",
	{
		description: "Select one or more values from a select element.",
		inputSchema: {
			pageId: z.string().optional(),
			selector: z.string(),
			values: z.array(z.string()).min(1),
		},
	},
	async (args) => textResult(await executeBrowserAction({ action: "select", ...args })),
)

server.registerTool(
	"browser_upload",
	{
		description: "Upload files using configured upload paths or absolute paths.",
		inputSchema: {
			pageId: z.string().optional(),
			selector: z.string(),
			files: z.array(z.string()).min(1),
		},
	},
	async (args) => textResult(await executeBrowserAction({ action: "upload", ...args })),
)

server.registerTool(
	"browser_download",
	{
		description: "Click an element and save its download in the persistent download directory.",
		inputSchema: {
			pageId: z.string().optional(),
			selector: z.string(),
			filename: z.string().optional(),
		},
	},
	async (args) => textResult(await executeBrowserAction({ action: "download", ...args })),
)

server.registerTool(
	"browser_screenshot",
	{
		description: "Capture a PNG screenshot of a tab or selected element.",
		inputSchema: {
			pageId: z.string().optional(),
			fullPage: z.boolean().optional(),
			selector: z.string().optional(),
		},
	},
	async (args) => {
		const result = (await executeBrowserAction({ action: "screenshot", ...args })) as {
			base64: string
			mimeType: string
			url: string
			title: string
		}
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({ url: result.url, title: result.title }, null, 2),
				},
				{ type: "image" as const, data: result.base64, mimeType: result.mimeType },
			],
		}
	},
)

server.registerTool(
	"browser_storage",
	{
		description: "Inspect localStorage and cookies for the current page origin.",
		inputSchema: { pageId: z.string().optional() },
	},
	async ({ pageId }) => textResult(await executeBrowserAction({ action: "storage", pageId })),
)

server.registerTool(
	"browser_dialog_status",
	{
		description: "Inspect a pending JavaScript dialog.",
		inputSchema: { pageId: z.string() },
	},
	async ({ pageId }) => textResult(await executeBrowserAction({ action: "dialog_status", pageId })),
)

server.registerTool(
	"browser_dialog",
	{
		description: "Accept or dismiss a pending JavaScript dialog.",
		inputSchema: {
			pageId: z.string(),
			accept: z.boolean(),
			promptText: z.string().optional(),
		},
	},
	async (args) => textResult(await executeBrowserAction({ action: "dialog", ...args })),
)

await server.connect(new StdioServerTransport())
