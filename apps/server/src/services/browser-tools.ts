import { browserRuntime } from "./browser-runtime"

export type BrowserAction =
	| { action: "tabs" }
	| { action: "new_tab"; url?: string }
	| { action: "close_tab"; pageId: string }
	| { action: "navigate"; pageId?: string; url: string }
	| { action: "reload"; pageId?: string }
	| {
			action: "inspect"
			pageId?: string
			selector?: string
			mode?: "text" | "html"
			maxChars?: number
	  }
	| { action: "click"; pageId?: string; selector: string }
	| {
			action: "type"
			pageId?: string
			selector: string
			text: string
			append?: boolean
			pressEnter?: boolean
	  }
	| { action: "select"; pageId?: string; selector: string; values: string[] }
	| { action: "upload"; pageId?: string; selector: string; files: string[] }
	| { action: "download"; pageId?: string; selector: string; filename?: string }
	| { action: "screenshot"; pageId?: string; fullPage?: boolean; selector?: string }
	| { action: "dialog"; pageId: string; accept: boolean; promptText?: string }
	| { action: "dialog_status"; pageId: string }
	| { action: "storage"; pageId?: string }

export async function executeBrowserAction(input: BrowserAction): Promise<unknown> {
	return browserRuntime.action(input)
}
