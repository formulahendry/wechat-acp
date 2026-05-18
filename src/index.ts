/**
 * wechat-acp — public API
 */

export { WeChatAcpBridge } from "./bridge.js";
export type {
	AgentCommandConfig,
	AgentPreset,
	ResolvedAgentConfig,
	WeChatAcpConfig,
} from "./config.js";
export {
	BUILT_IN_AGENTS,
	defaultConfig,
	defaultStorageDir,
	listBuiltInAgents,
	parseAgentCommand,
	resolveAgentSelection,
	validateInstanceName,
} from "./config.js";
