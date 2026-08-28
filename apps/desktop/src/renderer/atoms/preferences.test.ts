import { afterEach, describe, expect, test } from "bun:test"
import { createStore } from "jotai"

class MemoryStorage implements Storage {
	private readonly values = new Map<string, string>()

	get length(): number {
		return this.values.size
	}

	clear(): void {
		this.values.clear()
	}

	getItem(key: string): string | null {
		return this.values.get(key) ?? null
	}

	key(index: number): string | null {
		return [...this.values.keys()][index] ?? null
	}

	removeItem(key: string): void {
		this.values.delete(key)
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value)
	}
}
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")

afterEach(() => {
	if (originalLocalStorageDescriptor) {
		Object.defineProperty(globalThis, "localStorage", originalLocalStorageDescriptor)
	} else {
		Reflect.deleteProperty(globalThis, "localStorage")
	}
})

describe("unified agent runtime persistence", () => {
	test("restores the provider session when switching away and back", async () => {
		Object.defineProperty(globalThis, "localStorage", {
			value: new MemoryStorage(),
			configurable: true,
		})
		const { sessionAgentRuntimesAtom, setSessionAgentRuntimeAtom } = await import("./preferences")
		const store = createStore()

		store.set(setSessionAgentRuntimeAtom, {
			sessionId: "ui-session",
			runtime: { provider: "codex", model: "gpt-5", agentSessionId: "codex-session" },
		})
		store.set(setSessionAgentRuntimeAtom, {
			sessionId: "ui-session",
			runtime: { provider: "claude", model: "sonnet", agentSessionId: "claude-session" },
		})
		store.set(setSessionAgentRuntimeAtom, {
			sessionId: "ui-session",
			runtime: { provider: "codex", model: "gpt-5" },
		})

		expect(store.get(sessionAgentRuntimesAtom)["ui-session"]).toEqual({
			provider: "codex",
			model: "gpt-5",
			agentSessionId: "codex-session",
			agentSessionIds: {
				"codex:gpt-5": "codex-session",
				"claude:sonnet": "claude-session",
			},
		})
	})
})
