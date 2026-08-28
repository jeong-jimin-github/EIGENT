import { describe, expect, test } from "bun:test"
import { CodexDriver, codexEvent } from "./index"

describe("Codex event mapping", () => {
	test("ignores diagnostic item.completed records instead of rendering them as tools", () => {
		expect(
			codexEvent({
				type: "item.completed",
				item: { id: "item_0", type: "error" },
			}),
		).toEqual([])
	})

	test("maps CLI errors", () => {
		expect(codexEvent({ type: "turn.failed", error: { message: "usage limit" } })).toEqual([
			{ type: "error", message: "usage limit", recoverable: true },
		])
	})
})

describe("Codex model selection", () => {
	test("offers the CLI default when no explicit model list is configured", async () => {
		const driver = new CodexDriver()
		expect(await driver.getModels()).toEqual([
			{
				id: "__default__",
				name: "CLI default",
				provider: "codex",
				reasoning: true,
				toolCalling: true,
			},
		])
	})
})
