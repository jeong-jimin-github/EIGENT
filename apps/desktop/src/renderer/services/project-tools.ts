/** Browser-side client for EIGENT workspace/process/terminal services. */

export interface WorkspaceEntry {
	name: string
	path: string
	type: "file" | "directory" | "symlink" | "other"
	size: number
	modifiedAt: number
}

export interface WorkspaceFile {
	path: string
	content: string
	size: number
	modifiedAt: number
}

export interface ManagedProcessInfo {
	id: string
	command: string
	cwd: string
	taskId?: string
	pid: number | null
	state: "running" | "exited" | "killed" | "failed" | "orphaned"
	exitCode: number | null
	startedAt: number
	endedAt: number | null
	output: string
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, {
		...init,
		headers: init?.body
			? { "content-type": "application/json", ...init.headers }
			: init?.headers,
	})
	const data = (await response.json()) as T
	if (!response.ok) {
		const errorData = data as { error?: unknown }
		const detail = typeof errorData.error === "string" ? errorData.error : null
		throw new Error(detail ?? `${response.status} ${response.statusText}`)
	}
	return data
}

export async function listWorkspace(root: string, path = ""): Promise<WorkspaceEntry[]> {
	const query = new URLSearchParams({ root, path })
	const data = await request<{ entries: WorkspaceEntry[] }>(`/api/workspace/list?${query}`)
	return data.entries
}

export async function readWorkspaceFile(root: string, path: string): Promise<WorkspaceFile> {
	const query = new URLSearchParams({ root, path })
	return request<WorkspaceFile>(`/api/workspace/read?${query}`)
}

export async function writeWorkspaceFile(root: string, path: string, content: string) {
	return request<{ path: string; size: number; modifiedAt: number }>("/api/workspace/write", {
		method: "PUT",
		body: JSON.stringify({ root, path, content }),
	})
}

export async function createProjectDirectory(name: string) {
	return request<{ path: string }>("/api/workspace/project", {
		method: "POST",
		body: JSON.stringify({ name }),
	})
}

export async function createWorkspaceDirectory(root: string, path: string) {
	return request<{ path: string }>("/api/workspace/mkdir", {
		method: "POST",
		body: JSON.stringify({ root, path }),
	})
}

export async function deleteWorkspacePath(root: string, path: string) {
	return request<{ deleted: string }>("/api/workspace/path", {
		method: "DELETE",
		body: JSON.stringify({ root, path }),
	})
}

export async function listProcesses(): Promise<ManagedProcessInfo[]> {
	const data = await request<{ processes: ManagedProcessInfo[] }>("/api/processes")
	return data.processes
}

export async function startProcess(command: string, cwd: string): Promise<ManagedProcessInfo> {
	return request<ManagedProcessInfo>("/api/processes", {
		method: "POST",
		body: JSON.stringify({ command, cwd }),
	})
}

export async function killProcess(id: string) {
	return request<{ killed: boolean }>(`/api/processes/${encodeURIComponent(id)}/kill`, {
		method: "POST",
	})
}

export function terminalWebSocketUrl(cwd: string): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
	const query = new URLSearchParams({ cwd })
	return `${protocol}//${window.location.host}/api/terminal/ws?${query}`
}
