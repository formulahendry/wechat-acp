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
	BRIDGE_COMMANDS,
	defaultConfig,
	defaultStorageDir,
	listBuiltInAgents,
	parseAgentCommand,
	resolveAgentSelection,
	resolveCommandAliases,
	resolveCommandNames,
	validateCommandAliases,
	validateInstanceName,
} from "./config.js";
