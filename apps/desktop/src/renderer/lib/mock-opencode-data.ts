/** Lightweight fixture data used synchronously by OpenCode data hooks in mock mode. */

// ============================================================
// Providers data (for model selector)
// ============================================================

export const MOCK_PROVIDERS = {
	providers: [
		{
			id: "bedrock",
			name: "AWS Bedrock",
			source: "builtin" as const,
			env: {},
			options: {},
			models: {
				"anthropic.claude-opus-4-6": {
					id: "anthropic.claude-opus-4-6",
					name: "Claude Opus 4.6",
					variants: {
						Adaptive: {
							name: "Adaptive",
							description: "Adaptive reasoning mode for complex tasks",
						},
						Standard: {
							name: "Standard",
							description: "Standard mode for general tasks",
						},
					},
					capabilities: {
						input: { image: true, pdf: true },
						attachment: true,
					},
				},
			},
		},
		{
			id: "anthropic",
			name: "Anthropic",
			source: "builtin" as const,
			env: {},
			options: {},
			models: {
				"claude-sonnet-4-20250514": {
					id: "claude-sonnet-4-20250514",
					name: "Claude Sonnet 4",
					capabilities: {
						input: { image: true, pdf: true },
						attachment: true,
					},
				},
			},
		},
	],
	defaults: {
		bedrock: "anthropic.claude-opus-4-6",
		anthropic: "claude-sonnet-4-20250514",
	},
}

// ============================================================
// Agents data
// ============================================================

export const MOCK_AGENTS = [
	{
		id: "build",
		name: "Build",
		description: "Expert at building new features and implementing complex functionality",
		mode: "primary" as const,
		hidden: false,
		permissions: [],
		options: {},
		model: {
			providerID: "bedrock",
			modelID: "anthropic.claude-opus-4-6",
		},
	},
	{
		id: "debug",
		name: "Debug",
		description: "Specialist in finding and fixing bugs",
		mode: "primary" as const,
		hidden: false,
		permissions: [],
		options: {},
	},
	{
		id: "default",
		name: "Default",
		description: "General-purpose assistant",
		mode: "primary" as const,
		hidden: false,
		permissions: [],
		options: {},
	},
]

// ============================================================
// Config data
// ============================================================

export const MOCK_CONFIG = {
	model: "bedrock/anthropic.claude-opus-4-6",
	smallModel: "anthropic/claude-sonnet-4-20250514",
	defaultAgent: "Build",
}
