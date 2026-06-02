export const FORK_REPO = "casepot/oh-my-pi";
export const UPSTREAM_REPO = "can1357/oh-my-pi";
export const FORK_REPO_URL = `https://github.com/${FORK_REPO}.git`;
export const UPSTREAM_REPO_URL = `https://github.com/${UPSTREAM_REPO}.git`;
export const DEFAULT_SOURCE_BRANCH = "main";

export const FORK_POLICY_DEFAULTS = {
	discoveryEnableUserSources: false,
	mcpEnableUserConfig: false,
	compactionAllowModelFallbacks: false,
	taskFallbackToParentModelOnAuthFailure: false,
	skillsEnableCodexUser: false,
	skillsEnableClaudeUser: false,
	skillsEnableClaudeProject: false,
	skillsEnablePiUser: false,
	skillsEnablePiProject: true,
	commandsEnableClaudeUser: false,
	commandsEnableOpencodeUser: false,
} as const;

export const FORK_REMOVED_SETTING_PATHS = ["contextPromotion", "contextPromotionTarget"] as const;
