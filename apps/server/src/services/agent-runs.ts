/** Process-wide agent run coordinator. */
import { AgentRunCoordinator } from "./agent-run-coordinator"
import { providerRegistry } from "./provider-registry"
import { stateStore } from "./state"
import { webPushService } from "./web-push"

export const agentRuns = new AgentRunCoordinator(providerRegistry, stateStore, webPushService)
