/** Serializable managed-process state shared by persistence and runtime layers. */
export type ManagedProcessState = "running" | "exited" | "killed" | "failed" | "orphaned"

export interface ManagedProcessInfo {
	id: string
	command: string
	cwd: string
	taskId?: string
	pid: number | null
	state: ManagedProcessState
	exitCode: number | null
	startedAt: number
	endedAt: number | null
	output: string
}
