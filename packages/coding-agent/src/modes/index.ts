import { emergencyTerminalRestore } from "@oh-my-pi/pi-tui";
import { postmortem } from "@oh-my-pi/pi-utils";

/**
 * Run modes for the coding agent.
 */
export { runAcpMode } from "./acp";
export { InteractiveMode, type InteractiveModeOptions } from "./interactive-mode";
export { type PrintModeOptions, runPrintMode } from "./print-mode";
export {
	defineRpcClientTool,
	type ModelInfo,
	RpcClient,
	type RpcClientCustomTool,
	type RpcClientHostUri,
	type RpcClientHostUriContext,
	type RpcClientOptions,
	type RpcClientToolContext,
	type RpcClientToolResult,
	type RpcEventListener,
	type RpcExtensionErrorListener,
	type RpcProtocolErrorListener,
	type RpcRawFrameListener,
	type RpcSessionEventListener,
	type RpcUnknownFrameListener,
} from "./rpc/rpc-client";
export { runRpcMode } from "./rpc/rpc-mode";
export * from "./rpc/rpc-types";

postmortem.register("terminal-restore", () => {
	emergencyTerminalRestore();
});
