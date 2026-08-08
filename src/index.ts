/**
 * wechat-acp — public API
 */

export { WeChatAcpBridge } from "./bridge.js";
export type {
	AgentCommandConfig,
	AgentPreset,
	ResolvedAgentConfig,
	SessionResumePolicy,
	WeChatAcpConfig,
} from "./config.js";
export {
	BUILT_IN_AGENTS,
	BRIDGE_COMMANDS,
	buildAgentSessionScope,
	defaultConfig,
	defaultStorageDir,
	listBuiltInAgents,
	parseAgentCommand,
	parseSessionResumePolicy,
	resolveAgentSelection,
	resolveCommandAliases,
	resolveCommandNames,
	validateCommandAliases,
	validateInstanceName,
} from "./config.js";
