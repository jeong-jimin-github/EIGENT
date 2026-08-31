const OPENCODE_DIRECTORY_HEADER = "x-opencode-directory"

export function scopeOpenCodeSessionRequest(
	headers: Headers,
	pathname: string,
	defaultDirectory: string,
): void {
	if (pathname !== "/session" && !pathname.startsWith("/session/")) return
	if (headers.get(OPENCODE_DIRECTORY_HEADER)?.trim()) return
	headers.set(OPENCODE_DIRECTORY_HEADER, defaultDirectory)
}
