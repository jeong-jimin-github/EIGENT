/**
 * Production-capable Vite config for EIGENT browser mode.
 * Development proxies API traffic to the Bun/Hono server; production emits
 * static assets that the same server serves from one origin.
 */
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
	root: __dirname,
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": __dirname,
			"@palot/ui": path.resolve(__dirname, "../../../../packages/ui/src"),
		},
	},
	clearScreen: false,
	build: {
		outDir: path.resolve(__dirname, "../../dist-web"),
		emptyOutDir: true,
	},
	server: {
		host: "0.0.0.0",
		port: 1420,
		strictPort: true,
		proxy: {
			"/api": "http://127.0.0.1:3100",
			"/health": "http://127.0.0.1:3100",
		},
	},
})
