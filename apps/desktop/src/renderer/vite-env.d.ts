/** Vite-specific extensions to ImportMeta (renderer process only). */
interface ImportMetaEnv {
	readonly DEV: boolean
	readonly PROD: boolean
	readonly MODE: string
	readonly BASE_URL: string
	readonly SSR: boolean
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}

declare module "@novnc/novnc" {
	export default class RFB extends EventTarget {
		constructor(target: HTMLElement, url: string, options?: { credentials?: Record<string, string> })
		viewOnly: boolean
		scaleViewport: boolean
		resizeSession: boolean
		clipViewport: boolean
		background: string
		disconnect(): void
		clipboardPasteFrom(text: string): void
	}
}
