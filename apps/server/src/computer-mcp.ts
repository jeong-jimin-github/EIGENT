import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const baseUrl = (process.env.EIGENT_SERVER_URL?.trim() || "http://127.0.0.1:3100").replace(
	/\/$/,
	"",
)
const server = new McpServer({ name: "eigent-computer", version: "0.1.0" })
const textResult = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
})

async function request<T>(requestPath: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`${baseUrl}${requestPath}`, init)
	const body = (await response.json()) as T & { error?: string }
	if (!response.ok || body.error)
		throw new Error(body.error ?? `EIGENT returned HTTP ${response.status}`)
	return body
}

async function action<T>(payload: Record<string, unknown>): Promise<T> {
	const body = await request<{ result: T }>("/api/desktop/computer", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	})
	return body.result
}

server.registerTool(
	"computer_status",
	{ description: "Get the shared EIGENT desktop and control status." },
	async () => textResult(await request("/api/desktop/status")),
)

server.registerTool(
	"computer_screenshot",
	{ description: "Capture the shared Linux desktop." },
	async () => {
		const result = await action<{ base64: string; mimeType: "image/png" }>({ action: "screenshot" })
		return { content: [{ type: "image" as const, data: result.base64, mimeType: result.mimeType }] }
	},
)

server.registerTool(
	"computer_mouse_move",
	{
		description: "Move the mouse on the shared desktop.",
		inputSchema: { x: z.number(), y: z.number() },
	},
	async (args) => textResult(await action({ action: "mouse_move", ...args })),
)

server.registerTool(
	"computer_mouse_click",
	{
		description: "Click on the shared desktop, optionally at an absolute coordinate.",
		inputSchema: {
			x: z.number().optional(),
			y: z.number().optional(),
			button: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
			count: z.number().int().min(1).max(3).optional(),
		},
	},
	async (args) => textResult(await action({ action: "mouse_click", ...args })),
)

server.registerTool(
	"computer_key",
	{
		description: "Send a key combination, for example ctrl+l or Return.",
		inputSchema: { keys: z.array(z.string()).min(1) },
	},
	async ({ keys }) => textResult(await action({ action: "key", keys })),
)

server.registerTool(
	"computer_type",
	{
		description: "Type text into the focused desktop application.",
		inputSchema: { text: z.string(), intervalMs: z.number().int().min(0).max(1000).optional() },
	},
	async (args) => textResult(await action({ action: "type", ...args })),
)

server.registerTool(
	"computer_windows",
	{ description: "List visible desktop windows." },
	async () => textResult(await action({ action: "windows" })),
)

server.registerTool(
	"computer_activate_window",
	{
		description: "Activate a visible desktop window by id.",
		inputSchema: { id: z.string() },
	},
	async ({ id }) => textResult(await action({ action: "activate_window", id })),
)

server.registerTool(
	"computer_launch",
	{
		description: "Launch a GUI application inside the shared desktop session.",
		inputSchema: { command: z.string(), args: z.array(z.string()).optional() },
	},
	async (args) => textResult(await action({ action: "launch", ...args })),
)

server.registerTool(
	"computer_clipboard_get",
	{ description: "Read the shared desktop clipboard." },
	async () => textResult(await action({ action: "clipboard_get" })),
)

server.registerTool(
	"computer_clipboard_set",
	{
		description: "Replace the shared desktop clipboard text.",
		inputSchema: { text: z.string() },
	},
	async ({ text }) => textResult(await action({ action: "clipboard_set", text })),
)

await server.connect(new StdioServerTransport())
