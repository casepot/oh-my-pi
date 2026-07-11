import type { Socket } from "bun";
import {
	IRC_OBSERVER_MAX_RECORD_BYTES,
	IRC_OBSERVER_PROTOCOL_VERSION,
	type IrcObserverRecordV1,
	type IrcObserverStateCode,
	type IrcObserverWorkerConfig,
	type IrcObserverWorkerInbound,
	type IrcObserverWorkerOutbound,
} from "./protocol";

interface WorkerTransport {
	send(message: IrcObserverWorkerOutbound): void;
	sendAndFlush(message: IrcObserverWorkerOutbound): Promise<void>;
	onMessage(handler: (message: IrcObserverWorkerInbound) => void): () => void;
}

interface ParsedLine {
	readonly tags: ReadonlyMap<string, string>;
	readonly prefix?: string;
	readonly command: string;
	readonly params: readonly string[];
}

interface PendingEcho {
	readonly eventId: string;
	readonly command: "PRIVMSG" | "NOTICE";
	readonly channel: string;
	readonly text: string;
	readonly tag: string;
	readonly final: boolean;
}

interface PendingChannelPolicy {
	readonly channel: string;
	readonly record: IrcObserverRecordV1;
	readonly lines: PendingEcho[];
	modesReady: boolean;
	publisherReady: boolean;
	viewerReady: boolean;
	namesComplete: boolean;
	invalid: boolean;
}

const REQUIRED_CAPS = ["sasl", "echo-message", "message-tags", "account-tag", "server-time"] as const;
const encoder = new TextEncoder();

export function escapeIrcObserverText(value: string): string {
	let result = "";
	for (const char of value) {
		const code = char.codePointAt(0) as number;
		if (char === "\\") result += "\\\\";
		else if (char === "\r") result += "\\r";
		else if (char === "\n") result += "\\n";
		else if (char === "\0") result += "\\0";
		else if (
			code < 0x20 ||
			(code >= 0x7f && code <= 0x9f) ||
			(code >= 0xd800 && code <= 0xdfff) ||
			(code >= 0x200b && code <= 0x200f) ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2060 && code <= 0x206f) ||
			code === 0xfeff
		)
			result += `\\u{${code.toString(16)}}`;
		else result += char;
	}
	return result;
}

function slug(value: string, limit: number, fallback: string): string {
	return (
		value
			.normalize("NFKD")
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "")
			.slice(0, limit) || fallback
	);
}

function sha256(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function observerChannel(config: IrcObserverWorkerConfig, record: IrcObserverRecordV1): string {
	const processSlug = slug(config.identity.processLabel, 12, "omp");
	const processHash = sha256(config.identity.processInstanceId);
	if (record.rootAgentId === "unresolved" || record.rootSessionId === "unresolved")
		return `#omp-${processSlug}-unscoped-${processHash.slice(0, 24)}`;
	const rootSlug = slug(record.rootAgentId, 8, "root");
	const channelHash = sha256(
		JSON.stringify([config.identity.processInstanceId, record.rootAgentId, record.rootSessionId]),
	);
	return `#omp-${processSlug}-${rootSlug}-${channelHash.slice(0, 32)}`;
}

function parseLine(line: string): ParsedLine | undefined {
	if (!line || line.includes("\0")) return undefined;
	let rest = line;
	const tags = new Map<string, string>();
	if (rest.startsWith("@")) {
		const end = rest.indexOf(" ");
		if (end < 0) return undefined;
		for (const tag of rest.slice(1, end).split(";")) {
			const [key, value = ""] = tag.split("=", 2);
			if (key) tags.set(key, value);
		}
		rest = rest.slice(end + 1);
	}
	let prefix: string | undefined;
	if (rest.startsWith(":")) {
		const end = rest.indexOf(" ");
		if (end < 0) return undefined;
		prefix = rest.slice(1, end);
		rest = rest.slice(end + 1);
	}
	const trailing = rest.indexOf(" :");
	const middle = trailing >= 0 ? rest.slice(0, trailing) : rest;
	const pieces = middle.split(/ +/u).filter(Boolean);
	const command = pieces.shift();
	if (!command) return undefined;
	const params = trailing >= 0 ? [...pieces, rest.slice(trailing + 2)] : pieces;
	return { tags, ...(prefix ? { prefix } : {}), command: command.toUpperCase(), params };
}

function splitUtf8(value: string, maxBytes: number): string[] {
	const chunks: string[] = [];
	let chunk = "";
	let bytes = 0;
	for (const char of value) {
		const charBytes = encoder.encode(char).byteLength;
		if (bytes + charBytes > maxBytes && chunk) {
			chunks.push(chunk);
			chunk = "";
			bytes = 0;
		}
		chunk += char;
		bytes += charBytes;
	}
	if (chunk || chunks.length === 0) chunks.push(chunk);
	return chunks;
}

function validateInit(
	message: IrcObserverWorkerInbound,
): message is Extract<IrcObserverWorkerInbound, { type: "init" }> {
	if (message.type !== "init" || message.version !== IRC_OBSERVER_PROTOCOL_VERSION || !message.generation)
		return false;
	const { config } = message;
	return (
		(config.endpoint.hostname === "127.0.0.1" || config.endpoint.hostname === "::1") &&
		Number.isInteger(config.endpoint.port) &&
		config.endpoint.port >= 1 &&
		config.endpoint.port <= 65_535 &&
		config.endpoint.tls === true &&
		encoder.encode(config.endpoint.caPem).byteLength <= IRC_OBSERVER_MAX_RECORD_BYTES &&
		/^[A-Za-z][A-Za-z0-9_-]{0,29}$/u.test(config.identity.publisherNick) &&
		/^[A-Za-z][A-Za-z0-9_-]{0,29}$/u.test(config.auth.viewerNick)
	);
}

export function startIrcObserverWorker(transport: WorkerTransport): void {
	let generation: string | undefined;
	let connecting: Promise<Socket<undefined> | undefined> | undefined;
	let config: IrcObserverWorkerConfig | undefined;
	let socket: Socket<undefined> | undefined;
	let decoder = new TextDecoder("utf-8", { fatal: true });
	let remainder = "";
	let stopped = false;
	let operated = false;
	let viewerOnline = false;
	let connectionNonce = "";
	let caps = new Set<string>();
	let supportsMonitor = false;
	let channelLength = 0;
	let pendingEcho: PendingEcho | undefined;
	let publishQueue: { record: IrcObserverRecordV1; lines: PendingEcho[] } | undefined;
	let pendingPolicy: PendingChannelPolicy | undefined;
	const lanePending = new Map<string, boolean>();
	let reconnectTimer: NodeJS.Timeout | undefined;
	let attempt = 0;
	let phaseTimer: NodeJS.Timeout | undefined;
	let echoTimer: NodeJS.Timeout | undefined;

	const emitState = (code: IrcObserverStateCode): void => {
		if (generation) transport.send({ type: "state", generation, code });
	};
	const setViewerOnline = (online: boolean): void => {
		if (!generation || viewerOnline === online) return;
		viewerOnline = online;
		transport.send({ type: "viewer", generation, connectionNonce, online });
		if (online) sendNextEcho();
	};

	const write = (line: string): boolean => {
		if (!socket || encoder.encode(`${line}\r\n`).byteLength > 512) {
			emitState("line_too_long");
			return false;
		}
		try {
			socket.write(`${line}\r\n`);
			return true;
		} catch {
			return false;
		}
	};
	const completeRegistration = (): void => {
		if (!operated || !config || !generation || !supportsMonitor || channelLength < 59) return;
		clearTimeout(phaseTimer);
		connectionNonce = Bun.randomUUIDv7();
		transport.send({ type: "connected", generation, connectionNonce });
		write(`MONITOR + ${config.auth.viewerNick}`);
	};
	const channels = new Map<string, { laneKey: string; lastUsed: number }>();
	const retireChannel = (channel: string): void => {
		if (!config) return;
		write(`KICK ${channel} ${config.auth.viewerNick} :[omp/retire/v1]`);
		write(`PART ${channel} :[omp/retire/v1]`);
		channels.delete(channel);
	};
	const retirementTimer = setInterval(() => {
		const cutoff = Date.now() - 15 * 60_000;
		for (const [channel, state] of channels) {
			if (state.lastUsed <= cutoff && lanePending.get(state.laneKey) === false) retireChannel(channel);
		}
	}, 60_000);
	retirementTimer.unref?.();

	const resetPhaseDeadline = (code: "connecting" | "auth_failed" | "oper_auth_failed"): void => {
		clearTimeout(phaseTimer);
		phaseTimer = setTimeout(() => {
			emitState(code);
			if (code === "connecting") reconnect();
		}, 10_000);
	};

	const clearConnection = (): void => {
		clearTimeout(phaseTimer);
		clearTimeout(echoTimer);
		try {
			socket?.end();
		} catch {
			// Already closed.
		}
		if (connecting) connecting = undefined;
		socket = undefined;
		operated = false;
		viewerOnline = false;
		pendingEcho = undefined;
		publishQueue = undefined;
		pendingPolicy = undefined;
		decoder = new TextDecoder("utf-8", { fatal: true });
		remainder = "";
		caps = new Set();
		supportsMonitor = false;
		channelLength = 0;
		channels.clear();
	};

	const reconnect = (): void => {
		if (stopped || !config) return;
		clearConnection();
		clearTimeout(reconnectTimer);
		const cap = Math.min(250 * 2 ** attempt++, 30_000);
		reconnectTimer = setTimeout(connect, cap / 2 + Math.random() * (cap / 2));
	};

	const sendNextEcho = (): void => {
		if (!publishQueue || pendingEcho || !viewerOnline || !operated) return;
		const next = publishQueue.lines.shift();
		if (!next) {
			transport.send({
				type: "acked",
				generation: generation as string,
				connectionNonce,
				eventId: publishQueue.record.eventId,
			});
			publishQueue = undefined;
			return;
		}
		pendingEcho = next;
		if (!write(`@+omp.sh/observer=${next.tag} ${next.command} ${next.channel} :${next.text}`)) return;
		clearTimeout(echoTimer);
		echoTimer = setTimeout(() => {
			emitState("echo_timeout");
			reconnect();
		}, 15_000);
	};

	const finishChannelPolicy = (): void => {
		if (!pendingPolicy?.modesReady || !pendingPolicy.namesComplete) return;
		if (pendingPolicy.invalid || !pendingPolicy.publisherReady || !pendingPolicy.viewerReady) {
			emitState("channel_policy_failed");
			return;
		}
		publishQueue = { record: pendingPolicy.record, lines: pendingPolicy.lines };
		pendingPolicy = undefined;
		sendNextEcho();
	};

	const setupAndPublish = (record: IrcObserverRecordV1): void => {
		if (!config || !generation) return;
		if (!viewerOnline) {
			transport.send({
				type: "blocked",
				generation,
				connectionNonce,
				eventId: record.eventId,
				code: "viewer_offline",
			});
			return;
		}
		const channel = observerChannel(config, record);
		const recordLaneKey = JSON.stringify([record.rootAgentId, record.rootSessionId]);
		if (!channels.has(channel) && channels.size >= 32) {
			const eligible = [...channels.entries()]
				.filter(([, state]) => lanePending.get(state.laneKey) === false)
				.sort((left, right) => left[1].lastUsed - right[1].lastUsed)[0];
			if (!eligible) {
				transport.send({
					type: "blocked",
					generation,
					connectionNonce,
					eventId: record.eventId,
					code: "channel_not_ready",
				});
				return;
			}
			retireChannel(eligible[0]);
		}
		channels.set(channel, { laneKey: recordLaneKey, lastUsed: Date.now() });
		write(`SAJOIN ${channel}`);
		write(`SAMODE ${channel} +imnst`);
		write(`SAMODE ${channel} +o ${config.identity.publisherNick}`);
		write(`SAJOIN ${config.auth.viewerNick} ${channel}`);
		write(
			`TOPIC ${channel} :${escapeIrcObserverText(config.identity.processLabel)} / ${escapeIrcObserverText(
				record.schema === "omp.irc.message.v1" ? (record.rootSessionLabel ?? "") : "",
			)} / ${escapeIrcObserverText(record.rootSessionId)}`,
		);
		const processShort = sha256(config.identity.processInstanceId).slice(0, 12);
		const sessionShort = sha256(
			JSON.stringify([config.identity.processInstanceId, record.rootAgentId, record.rootSessionId]),
		).slice(0, 12);
		const lines: PendingEcho[] = [];
		if (record.schema === "omp.irc.gap.v1") {
			const text = `[omp/gap/v1 p=${processShort} s=${sessionShort} seq=${record.sequenceStart}..${record.sequenceEnd} exact=${record.exactRange} reason=${record.reason} certainty=not_sent count=${record.droppedCount} bytes=${record.droppedBytes}]`;
			lines.push({
				eventId: record.eventId,
				command: "PRIVMSG",
				channel,
				text,
				tag: `${record.eventId}:gap:0:${connectionNonce}`,
				final: true,
			});
		} else {
			const escapedBody = escapeIrcObserverText(record.body);
			const route = `${escapeIrcObserverText(record.from)}→${escapeIrcObserverText(record.to)}`;
			const chunks = splitUtf8(escapedBody, 220);
			lines.push({
				eventId: record.eventId,
				command: "PRIVMSG",
				channel,
				text: `[omp/activity/v1 event=${record.eventId} parts=${chunks.length}]`,
				tag: `${record.eventId}:activity:0:${connectionNonce}`,
				final: false,
			});
			for (let index = 0; index < chunks.length; index++) {
				const text = `[omp/v1 p=${processShort} s=${sessionShort} seq=${record.sequence} id=${escapeIrcObserverText(record.messageId)} origin=${record.origin} ${route} reply=${escapeIrcObserverText(record.replyTo ?? "-")} part=${index + 1}/${chunks.length}] ${chunks[index]}`;
				lines.push({
					eventId: record.eventId,
					command: "NOTICE",
					channel,
					text,
					tag: `${record.eventId}:body:${index + 1}:${connectionNonce}`,
					final: index + 1 === chunks.length,
				});
			}
		}
		pendingPolicy = {
			channel,
			record,
			lines,
			modesReady: false,
			publisherReady: false,
			viewerReady: false,
			namesComplete: false,
			invalid: false,
		};
		write(`MODE ${channel}`);
		write(`NAMES ${channel}`);
	};

	const handleLine = (line: ParsedLine): void => {
		if (line.command === "PING") {
			write(`PONG :${line.params.at(-1) ?? ""}`);
			return;
		}
		if (line.command === "CAP" && line.params.includes("LS")) {
			for (const cap of (line.params.at(-1) ?? "").split(" ")) caps.add(cap.split("=")[0] as string);
			if (line.params.at(-2) !== "*") {
				if (!REQUIRED_CAPS.every(cap => caps.has(cap))) {
					emitState("missing_capability");
					return;
				}
				write(`CAP REQ :${REQUIRED_CAPS.join(" ")}`);
			}
			return;
		}
		if (line.command === "CAP" && line.params.includes("ACK")) {
			write("AUTHENTICATE PLAIN");
			resetPhaseDeadline("auth_failed");
			return;
		}
		if (line.command === "AUTHENTICATE" && line.params[0] === "+" && config) {
			const payload = Buffer.from(
				`${config.auth.account}\0${config.auth.account}\0${config.auth.password}`,
			).toString("base64");
			for (let offset = 0; offset < payload.length; offset += 400)
				write(`AUTHENTICATE ${payload.slice(offset, offset + 400)}`);
			if (payload.length % 400 === 0) write("AUTHENTICATE +");
			return;
		}
		if (line.command === "903") {
			write("CAP END");
			resetPhaseDeadline("connecting");
			return;
		}
		if (["904", "905", "906", "907"].includes(line.command)) {
			emitState("auth_failed");
			return;
		}
		if (line.command === "005") {
			for (const token of line.params) {
				if (token === "MONITOR" || token.startsWith("MONITOR=")) supportsMonitor = true;
				if (token.startsWith("CHANNELLEN=")) channelLength = Number(token.slice(11));
			}
			completeRegistration();
			return;
		}
		if (line.command === "001" && config) {
			write(`OPER ${config.auth.operName} ${config.auth.operPassword}`);
			resetPhaseDeadline("oper_auth_failed");
			return;
		}
		if (line.command === "381") {
			operated = true;
			completeRegistration();
			return;
		}
		if ((line.command === "376" || line.command === "422") && operated) {
			if (!supportsMonitor || channelLength < 59) emitState("missing_capability");
			return;
		}
		if (line.command === "324" && pendingPolicy) {
			const channel = line.params.at(-2);
			const modes = line.params.at(-1) ?? "";
			if (channel?.toLowerCase() === pendingPolicy.channel.toLowerCase()) {
				pendingPolicy.modesReady = ["i", "m", "n", "s", "t"].every(mode => modes.includes(mode));
				if (!pendingPolicy.modesReady) pendingPolicy.invalid = true;
				finishChannelPolicy();
			}
			return;
		}
		if (line.command === "353" && pendingPolicy && config) {
			const channel = line.params.at(-2);
			if (channel?.toLowerCase() !== pendingPolicy.channel.toLowerCase()) return;
			for (const decoratedNick of (line.params.at(-1) ?? "").split(" ")) {
				const nick = decoratedNick.replace(/^[~&@%+]+/u, "");
				const prefixes = decoratedNick.slice(0, decoratedNick.length - nick.length);
				if (nick.toLowerCase() === config.identity.publisherNick.toLowerCase())
					pendingPolicy.publisherReady = prefixes.includes("@");
				else if (nick.toLowerCase() === config.auth.viewerNick.toLowerCase())
					pendingPolicy.viewerReady = prefixes.length === 0;
				else if (nick.toLowerCase().startsWith("omp-p-")) pendingPolicy.invalid = true;
			}
			return;
		}
		if (line.command === "366" && pendingPolicy) {
			const channel = line.params.at(-2);
			if (channel?.toLowerCase() === pendingPolicy.channel.toLowerCase()) {
				pendingPolicy.namesComplete = true;
				finishChannelPolicy();
			}
			return;
		}
		if (line.command === "433") emitState("nick_in_use");
		if (line.command === "481" || line.command === "491") emitState("oper_auth_failed");
		if (line.command === "417") emitState("line_too_long");
		if ((line.command === "730" || line.command === "731") && config && generation) {
			setViewerOnline(line.command === "730");
			return;
		}
		const viewerNick = config?.auth.viewerNick.toLowerCase();
		if (
			viewerNick &&
			((line.command === "QUIT" && line.prefix?.split("!", 1)[0]?.toLowerCase() === viewerNick) ||
				(line.command === "401" && line.params.some(param => param.toLowerCase() === viewerNick)))
		) {
			setViewerOnline(false);
			return;
		}
		if (pendingEcho && (line.command === "PRIVMSG" || line.command === "NOTICE")) {
			const correlation = line.tags.get("+omp.sh/observer") ?? line.tags.get("omp.sh/observer");
			if (correlation !== pendingEcho.tag) return;
			const sourceNick = line.prefix?.split("!", 1)[0];
			const matches =
				config !== undefined &&
				sourceNick?.toLowerCase() === config.identity.publisherNick.toLowerCase() &&
				line.tags.get("account")?.toLowerCase() === config.auth.account.toLowerCase() &&
				line.command === pendingEcho.command &&
				line.params[0]?.toLowerCase() === pendingEcho.channel.toLowerCase() &&
				line.params.at(-1) === pendingEcho.text;
			if (!matches) {
				emitState("echo_content_mismatch");
				return;
			}
			clearTimeout(echoTimer);
			pendingEcho = undefined;
			sendNextEcho();
		}
	};

	const connect = (): void => {
		if (!config || stopped) return;
		emitState("connecting");
		resetPhaseDeadline("connecting");
		connecting = Bun.connect({
			hostname: config.endpoint.hostname,
			port: config.endpoint.port,
			tls: { ca: config.endpoint.caPem, serverName: config.endpoint.hostname },
			socket: {
				open(openSocket) {
					socket = openSocket;
					attempt = 0;
					queueMicrotask(() => {
						write("CAP LS 302");
						write(`NICK ${config?.identity.publisherNick ?? "omp-p-invalid"}`);
						write("USER u 0 * :OMP IRC Observer");
					});
				},
				data(_socket, data) {
					try {
						remainder += decoder.decode(data, { stream: true });
						if (remainder.includes("\0") || remainder.length > 8_192 || /(^|[^\r])\n/u.test(remainder))
							throw new Error("invalid_frame");
						for (;;) {
							const boundary = remainder.indexOf("\r\n");
							if (boundary < 0) break;
							const raw = remainder.slice(0, boundary);
							remainder = remainder.slice(boundary + 2);
							const parsed = parseLine(raw);
							if (parsed) handleLine(parsed);
						}
					} catch {
						reconnect();
					}
				},
				close() {
					if (!stopped) reconnect();
				},
				error() {
					if (!stopped) reconnect();
				},
			},
		}).catch(() => {
			reconnect();
			return undefined;
		});
	};

	transport.onMessage(message => {
		if (message.type === "ping") {
			transport.send({ type: "pong", id: message.id });
			return;
		}
		if (message.type === "init") {
			if (!validateInit(message) || generation) return;
			generation = message.generation;
			config = message.config;
			transport.send({ type: "booted", generation });
			connect();
			return;
		}
		if (!generation || message.generation !== generation) return;
		if (message.type === "lane_state") {
			lanePending.set(JSON.stringify([message.rootAgentId, message.rootSessionId]), message.pending);
			return;
		}
		if (message.type === "publish") {
			if (publishQueue || pendingEcho) return;
			setupAndPublish(message.record);
			return;
		}
		if (message.type === "stop") {
			stopped = true;
			clearTimeout(reconnectTimer);
			clearInterval(retirementTimer);
			for (const channel of [...channels.keys()]) retireChannel(channel);
			clearConnection();
			void transport.sendAndFlush({ type: "state", generation, code: "stopped" });
		}
	});
}
