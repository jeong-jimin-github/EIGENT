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
	sessionId: string
}): string {
	const webTask = looksLikeWebTask(args.userText)
	const workspacePreviewPayload = shellSingleQuote(
		JSON.stringify({
			sessionId: args.sessionId,
			root: args.workspaceRoot,
			kind: "workspace",
			path: "<workspace-relative-html-path>",
		}),
	)
	const loopbackPreviewPayload = shellSingleQuote(
		JSON.stringify({
			sessionId: args.sessionId,
			root: args.workspaceRoot,
			kind: "loopback",
			url: "http://127.0.0.1:5173/",
		}),
	)
	const sessionPayload = shellSingleQuote(JSON.stringify({ sessionId: args.sessionId }))
	const endpoint = '"http://127.0.0.1:${PORT:-3100}/api/workspace/session-preview"'
	const showWorkspacePreviewCommand =
		`curl -fsS -X POST ${endpoint} -H 'content-type: application/json' --data ${workspacePreviewPayload}`
	const showLoopbackPreviewCommand =
		`curl -fsS -X POST ${endpoint} -H 'content-type: application/json' --data ${loopbackPreviewPayload}`
	const previewReloadCommand =
		`curl -fsS -X POST "http://127.0.0.1:\${PORT:-3100}/api/workspace/session-preview/reload" ` +
		`-H 'content-type: application/json' --data ${sessionPayload}`
	const previewClearCommand =
		`curl -fsS -X DELETE ${endpoint} -H 'content-type: application/json' --data ${sessionPayload}`
	return [
		"EIGENT workspace/tool rules:",
		`- The project workspace root is ${args.workspaceRoot}. Treat this exact directory as the working project root.`,
		`- The current EIGENT UI session id is ${args.sessionId}. Preview state is isolated by this session id; never use another chat/session id.`,
		`- ${args.isNoProject ? "This is the persistent No Project workspace. It behaves like a normal project workspace, but the container project itself is permanent." : "Keep project work inside this workspace."}`,
		"- Create, edit, run, and inspect project files inside the workspace. Do not put project deliverables in $HOME, /tmp, or the filesystem root.",
		"- Project Tools exposes the same workspace through Files, Terminal, and Processes.",
		"- Device Preview is agent-controlled and does NOT auto-detect index.html or other HTML files. Use the preview tool commands below to explicitly choose what this session should show.",
		`- Show a workspace HTML file: replace <workspace-relative-html-path> with the exact HTML path, then run: ${showWorkspacePreviewCommand}`,
		`- Show a dev-server app: start it on 127.0.0.1 on a non-EIGENT port, adjust the URL if needed, then run: ${showLoopbackPreviewCommand}`,
		"- Showing another path/URL replaces only this UI session's preview. Other sessions keep their own independent previews.",
		`- Reload the active preview after browser-visible edits: ${previewReloadCommand}`,
		`- Explicitly clear this session's preview only when it should stop being shown: ${previewClearCommand}`,
		"- An active preview persists across EIGENT page refreshes until you explicitly replace or clear it. Do not clear it automatically when you finish a task.",
		"- Use browser automation tools separately when you need to inspect external sites. Device Preview accepts workspace HTML files or local loopback dev servers.",
		"- After a coherent batch of HTML/CSS/JS/app edits, reload the active preview before final visual verification. Do not ask the user to press refresh for changes you can reload yourself.",
		webTask
			? "- This request appears web-related: explicitly show the resulting page/app in this session's Device Preview before finishing, and report the exact workspace-relative entry path or loopback URL you verified."
			: "- If this request creates or modifies a webpage/app later, apply the explicit session Device Preview workflow above without waiting for another instruction.",
	].join("\n")
}

export async function workspaceAgentSystemPrompt(
	directory: string,
	userText: string,
	sessionId: string,
): Promise<string> {
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
		sessionId,
	})
}
