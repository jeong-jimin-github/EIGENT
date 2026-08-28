function splitCsv(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
}

function normalizeHost(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, "")
}

function isLocalHost(value: string): boolean {
	const host = normalizeHost(value)
	return (
		host === "localhost" ||
		host.startsWith("localhost:") ||
		host === "127.0.0.1" ||
		host.startsWith("127.0.0.1:") ||
		host === "[::1]" ||
		host.startsWith("[::1]:")
	)
}

export function isAllowedHost(requestHost: string | undefined): boolean {
	if (!requestHost) return false
	const configured = splitCsv(process.env.EIGENT_ALLOWED_HOSTS).map(normalizeHost)
	if (configured.length === 0) return true
	const candidate = normalizeHost(requestHost)
	return configured.includes(candidate)
}

export function isAllowedOrigin(
	origin: string | undefined,
	requestHost: string | undefined,
): boolean {
	if (!origin) return true
	const configured = splitCsv(process.env.EIGENT_ALLOWED_ORIGINS)
	if (configured.length > 0) return configured.includes(origin)

	try {
		const parsed = new URL(origin)
		if (requestHost && normalizeHost(parsed.host) === normalizeHost(requestHost)) return true
		return isLocalHost(parsed.host)
	} catch {
		return false
	}
}

function envInteger(name: string, fallback: number): number {
	const parsed = Number(process.env[name])
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

export function maxRequestBytes(): number {
	return envInteger("EIGENT_MAX_REQUEST_BYTES", 64 * 1024 * 1024)
}

export function maxUploadBytes(): number {
	return envInteger("EIGENT_MAX_UPLOAD_BYTES", 32 * 1024 * 1024)
}

let mutationWindowStartedAt = 0
let mutationCount = 0

export function consumeMutationRateLimit(now = Date.now()): {
	allowed: boolean
	retryAfter: number
} {
	const limit = envInteger("EIGENT_MUTATION_RATE_LIMIT_PER_MINUTE", 0)
	if (limit === 0) return { allowed: true, retryAfter: 0 }
	if (mutationWindowStartedAt === 0 || now - mutationWindowStartedAt >= 60_000) {
		mutationWindowStartedAt = now
		mutationCount = 0
	}
	mutationCount += 1
	if (mutationCount <= limit) return { allowed: true, retryAfter: 0 }
	return {
		allowed: false,
		retryAfter: Math.max(1, Math.ceil((60_000 - (now - mutationWindowStartedAt)) / 1000)),
	}
}

export function resetSecurityRateLimitForTests(): void {
	mutationWindowStartedAt = 0
	mutationCount = 0
}
