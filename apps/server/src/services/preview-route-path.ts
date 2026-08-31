/** Extract the path after a tokenized preview route without relying on Hono wildcard params. */
export function previewRequestPath(requestUrl: string, routePrefix: string, token: string): string {
	const pathname = new URL(requestUrl).pathname
	const normalizedPrefix = routePrefix.replace(/\/+$/, "")
	const tokenPrefix = `${normalizedPrefix}/${encodeURIComponent(token)}/`
	if (!pathname.startsWith(tokenPrefix)) return ""
	return pathname.slice(tokenPrefix.length)
}
