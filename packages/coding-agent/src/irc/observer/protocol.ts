import type { IrcMessageOrigin } from "../bus";

export const IRC_OBSERVER_PROTOCOL_VERSION = 1 as const;
export const IRC_OBSERVER_WORKER_ARG = "__omp_worker_irc_observer";

export interface IrcObserverMessageRecordV1 {
	readonly schema: "omp.irc.message.v1";
	readonly eventId: string;
	readonly processInstanceId: string;
	readonly processLabel: string;
	readonly rootAgentId: string;
	readonly rootSessionId: string;
	readonly rootSessionLabel?: string;
	readonly sequence: number;
	readonly messageId: string;
	readonly origin: IrcMessageOrigin;
	readonly from: string;
	readonly to: string;
	readonly replyTo?: string;
	readonly createdAt: number;
	readonly body: string;
}

export interface IrcObserverGapRecordV1 {
	readonly schema: "omp.irc.gap.v1";
	readonly eventId: string;
	readonly processInstanceId: string;
	readonly processLabel: string;
	readonly rootAgentId: string;
	readonly rootSessionId: string;
	readonly sequenceStart: number;
	readonly sequenceEnd: number;
	readonly droppedCount: number;
	readonly droppedBytes: number;
	readonly reason: "queue_overflow" | "record_oversize" | "gap_metadata_overflow";
	readonly certainty: "not_sent";
	readonly exactRange: boolean;
}

export type IrcObserverRecordV1 = IrcObserverMessageRecordV1 | IrcObserverGapRecordV1;

export interface IrcObserverWorkerConfig {
	readonly endpoint: {
		readonly hostname: "127.0.0.1" | "::1";
		readonly port: number;
		readonly tls: true;
		readonly caPem: string;
	};
	readonly identity: {
		readonly processInstanceId: string;
		readonly processLabel: string;
		readonly publisherNick: string;
	};
	readonly auth: {
		readonly account: string;
		readonly password: string;
		readonly operName: string;
		readonly operPassword: string;
		readonly viewerNick: string;
	};
}

export type IrcObserverStateCode =
	| "connecting"
	| "auth_failed"
	| "oper_auth_failed"
	| "nick_in_use"
	| "missing_capability"
	| "channel_policy_failed"
	| "line_too_long"
	| "echo_timeout"
	| "echo_content_mismatch"
	| "stopped";

export type IrcObserverWorkerInbound =
	| { type: "ping"; id: string }
	| { type: "init"; version: 1; generation: string; config: IrcObserverWorkerConfig }
	| { type: "lane_state"; generation: string; rootAgentId: string; rootSessionId: string; pending: boolean }
	| { type: "publish"; generation: string; record: IrcObserverRecordV1 }
	| { type: "stop"; generation: string };

export type IrcObserverWorkerOutbound =
	| { type: "pong"; id: string }
	| { type: "booted"; generation: string }
	| { type: "connected"; generation: string; connectionNonce: string }
	| { type: "viewer"; generation: string; connectionNonce: string; online: boolean }
	| {
			type: "blocked";
			generation: string;
			connectionNonce: string;
			eventId: string;
			code: "viewer_offline" | "channel_not_ready";
	  }
	| { type: "acked"; generation: string; connectionNonce: string; eventId: string }
	| { type: "state"; generation: string; code: IrcObserverStateCode };

export const IRC_OBSERVER_MAX_RECORD_BYTES = 1_048_576;
export const IRC_OBSERVER_MAX_QUEUE_RECORDS = 2_048;
export const IRC_OBSERVER_MAX_QUEUE_BYTES = 32 * 1_048_576;
