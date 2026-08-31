import { resolveWorkspaceRoot } from "./project-tools"

const rootCache = new Map<string, Promise<string>>()
const WEB_TASK_PATTERN = /\b(html?|css|javascript|typescript|react|vue|svelte|vite|frontend|web\s?page|website|browser|ui)\b|웹\s*페이지|웹사이트|프론트엔드|브라우저|페이지\s*(?:작성|만들|수정)|HTML/iu

export function looksLikeWebTask(text: string): boolean {
	return WEB_TASK_PATTERN.test(text)
}

function shellSingleQuote(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export function buildWorkspaceAgentSystemPrompt(args: {
	workspaceRoot: string
	isNoProject: boolean
	userText: string
}): string {
	const webTask = looksLikeWebTask(args.userText)
	const reloadPayload = shellSingleQuote(JSON.stringify({ root: args.workspaceRoot }))
	const previewReloadCommand =
		`curl -fsS -X POST "http://127.0.0.1:\${PORT:-3100}/api/workspace/preview-reload" ` +
		`-H 'content-type: application/json' --data ${reloadPayload}`
	return [
		"EIGENT workspace/tool rules:",
		`- The project workspace root is ${args.workspaceRoot}. Treat this exact directory as the working project root.`,
		`- ${args.isNoProject ? "This is the persistent No Project workspace. It behaves like a normal project workspace, but the container project itself is permanent." : "Keep project work inside this workspace."}`,
		"- Create, edit, run, and inspect project files inside the workspace. Do not put project deliverables in $HOME, /tmp, or the filesystem root.",
		"- Project Tools exposes the same workspace through Files, Terminal, and Processes.",
		"- For browser-viewable output, prefer an index.html entry when practical. EIGENT Device Preview can render workspace HTML directly on the user's device; clicking any .html/.htm file in Files opens that exact page in Device Preview.",
		"- For React/Vite/Vue/Svelte or another dev-server app, start the server on 127.0.0.1 on a non-EIGENT port (for example 5173), then open that localhost URL with the Cloud Browser. EIGENT will proxy an active loopback tab into Device Preview on the user's device.",
		"- Use Cloud Browser Live for external sites or browser automation; use Device Preview for the page/app being built.",
		`- Device Preview reload tool: after browser-visible edits, run this shell command to make the user's current Device Preview reload itself: ${previewReloadCommand}`,
		"- Use the Device Preview reload tool after a coherent batch of HTML/CSS/JS/app edits and before final visual verification. Do not ask the user to press refresh for changes you can reload yourself.",
		webTask
			? "- This request appears web-related: make the resulting page/app previewable before finishing, and report the workspace-relative entry path or loopback URL you verified."
			: "- If this request creates or modifies a webpage/app later, apply the Device Preview workflow above without waiting for another instruction.",
	].join("\n")
}

export async function workspaceAgentSystemPrompt(directory: string, userText: string): Promise<string> {
	const key = directory.trim()
	let rootPromise = rootCache.get(key)
	if (!rootPromise) {
		rootPromise = resolveWorkspaceRoot(directory)
		rootCache.set(key, rootPromise)
	}
	let workspaceRoot: string
	try {
		workspaceRoot = await rootPromise
	} catch {
		rootCache.delete(key)
		workspaceRoot = directory.trim() || "."
	}
	return buildWorkspaceAgentSystemPrompt({
		workspaceRoot,
		isNoProject: !directory.trim(),
		userText,
	})
}
