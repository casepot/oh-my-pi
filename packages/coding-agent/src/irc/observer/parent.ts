import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { AgentRegistry } from "../../registry/agent-registry";
import { AgentRegistry as Registry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	type WorkerHandle,
} from "../../subprocess/worker-client";
import { expandTilde } from "../../tools/path-utils";
import { IrcBus, type IrcMessageCreatedEvent } from "../bus";
import { IrcObserverSessionIndex } from "./attribution";
import { ircObserverWorkerEnv } from "./env";
import {
	IRC_OBSERVER_MAX_QUEUE_BYTES,
	IRC_OBSERVER_MAX_QUEUE_RECORDS,
	IRC_OBSERVER_MAX_RECORD_BYTES,
	IRC_OBSERVER_PROTOCOL_VERSION,
	IRC_OBSERVER_WORKER_ARG,
	type IrcObserverGapRecordV1,
	type IrcObserverMessageRecordV1,
	type IrcObserverRecordV1,
	type IrcObserverWorkerConfig,
	type IrcObserverWorkerInbound,
	type IrcObserverWorkerOutbound,
} from "./protocol";

const encoder = new TextEncoder();
const NICK_RE = /^[A-Za-z][A-Za-z0-9_-]{0,29}$/;
const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

interface QueueEntry {
	readonly json: string;
	readonly bytes: number;
	readonly eventId: string;
	readonly sequenceStart: number;
	readonly sequenceEnd: number;
	readonly droppedCount: number;
	readonly droppedBytes: number;
	readonly isGap: boolean;
}

interface Lane {
	readonly rootAgentId: string;
	readonly rootSessionId: string;
	readonly entries: QueueEntry[];
	blocked: boolean;
}

export interface StartIrcObserverOptions {
	readonly settings: Settings;
	readonly cwd: string;
	readonly bus?: IrcBus;
	readonly registry?: AgentRegistry;
}

export interface IrcObserverController {
	bindTopLevel(agentId: string, session: AgentSession): void;
	stop(mode: "normal" | "postmortem"): Promise<void>;
}

function sha256(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

async function readSecureFile(filePath: string, secret: boolean): Promise<string> {
	if (process.platform === "win32") throw new Error("unsupported_acl");
	const handle = await fs.promises.open(expandTilde(filePath), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new Error("unsafe_file");
		if (secret && (stat.mode & 0o077) !== 0) throw new Error("unsafe_mode");
		const limit = secret ? 4_098 : IRC_OBSERVER_MAX_RECORD_BYTES;
		if (stat.size < 1 || stat.size > limit) throw new Error("invalid_size");
		const value = (await handle.readFile()).toString("utf8");
		if (!secret) return value;
		const trimmed = value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
		const bytes = encoder.encode(trimmed).byteLength;
		if (bytes < 1 || bytes > 4_096 || /[\r\n\0]/u.test(trimmed)) throw new Error("invalid_secret");
		return trimmed;
	} finally {
		await handle.close();
	}
}

function configuredString(settings: Settings, setting: Parameters<Settings["getGlobal"]>[0]): string {
	const value = settings.getGlobal(setting);
	if (typeof value !== "string") throw new Error("missing_configuration");
	return value;
}

async function loadConfig(
	settings: Settings,
	identity: IrcObserverWorkerConfig["identity"],
): Promise<IrcObserverWorkerConfig | null> {
	if (!settings.getGlobal("irc.observer.enabled")) return null;
	try {
		const endpoint = new URL(configuredString(settings, "irc.observer.endpoint"));
		if (
			endpoint.protocol !== "ircs:" ||
			endpoint.username ||
			endpoint.password ||
			endpoint.search ||
			endpoint.hash ||
			(endpoint.pathname !== "" && endpoint.pathname !== "/") ||
			!endpoint.port ||
			!/^\d+$/u.test(endpoint.port)
		)
			throw new Error("invalid_endpoint");
		const port = Number(endpoint.port);
		const hostname = endpoint.hostname === "[::1]" ? "::1" : endpoint.hostname;
		if ((hostname !== "127.0.0.1" && hostname !== "::1") || port < 1 || port > 65_535)
			throw new Error("invalid_endpoint");
		const account = configuredString(settings, "irc.observer.account");
		const operName = configuredString(settings, "irc.observer.operName");
		const viewerNick = configuredString(settings, "irc.observer.viewerNick");
		if (!ACCOUNT_RE.test(account) || !ACCOUNT_RE.test(operName) || !NICK_RE.test(viewerNick))
			throw new Error("invalid_identity");
		if (
			viewerNick.toLowerCase() === identity.publisherNick.toLowerCase() ||
			viewerNick.toLowerCase().startsWith("omp-p-")
		)
			throw new Error("invalid_viewer");
		const [caPem, password, operPassword] = await Promise.all([
			readSecureFile(configuredString(settings, "irc.observer.caFile"), false),
			readSecureFile(configuredString(settings, "irc.observer.passwordFile"), true),
			readSecureFile(configuredString(settings, "irc.observer.operPasswordFile"), true),
		]);
		return {
			endpoint: { hostname, port, tls: true, caPem },
			identity,
			auth: { account, password, operName, operPassword, viewerNick },
		};
	} catch {
		logger.warn("IRC observer disabled", { code: "invalid_configuration" });
		return null;
	}
}

export async function startIrcObserver(options: StartIrcObserverOptions): Promise<IrcObserverController | null> {
	const processInstanceId = Bun.randomUUIDv7();
	const processLabel = path.basename(options.cwd) || "root";
	const processHash = sha256(processInstanceId);
	const identity = {
		processInstanceId,
		processLabel,
		publisherNick: `omp-p-${processHash.slice(0, 24)}`,
	};
	const config = await loadConfig(options.settings, identity);
	if (!config) return null;
	const bus = options.bus ?? IrcBus.global();
	const registry = options.registry ?? Registry.global();
	const index = new IrcObserverSessionIndex(registry);
	const generation = Bun.randomUUIDv7();
	const lanes = new Map<string, Lane>();
	const roundRobin: string[] = [];
	let sequence = 0;
	let queuedBytes = 0;
	let queuedRecords = 0;
	let inFlight: { laneKey: string; eventId: string } | undefined;
	let worker: WorkerHandle<IrcObserverWorkerInbound, IrcObserverWorkerOutbound> | undefined;
	let connectionNonce: string | undefined;
	let viewerOnline = false;
	let stopping = false;
	let stopPromise: Promise<void> | undefined;
	let rrCursor = 0;
	let quietTimer: NodeJS.Timeout | undefined;
	let heartbeatTimer: NodeJS.Timeout | undefined;
	let heartbeatMisses = 0;
	let heartbeatId: string | undefined;
	let workerStopped = false;
	let respawnAttempt = 0;
	let respawnTimer: NodeJS.Timeout | undefined;

	let startupTimer: NodeJS.Timeout | undefined;
	let emergencyGap:
		| { sequenceStart: number; sequenceEnd: number; droppedCount: number; droppedBytes: number }
		| undefined;
	let degradedCode: string | undefined;
	const reportDegraded = (code: string): void => {
		if (degradedCode === code) return;
		degradedCode = code;
		logger.warn("IRC observer degraded", { code, processInstanceId, generation });
	};
	const reportRecovered = (): void => {
		if (!degradedCode) return;
		degradedCode = undefined;
		respawnAttempt = 0;
		logger.info("IRC observer recovered", { processInstanceId, generation });
	};
	const send = (message: IrcObserverWorkerInbound): void => {
		try {
			worker?.send(message);
		} catch {
			// Supervision retains the queue and restarts the child.
		}
	};

	const laneKey = (rootAgentId: string, rootSessionId: string): string => JSON.stringify([rootAgentId, rootSessionId]);
	const getLane = (rootAgentId: string, rootSessionId: string): Lane => {
		const key = laneKey(rootAgentId, rootSessionId);
		let lane = lanes.get(key);
		if (!lane) {
			lane = { rootAgentId, rootSessionId, entries: [], blocked: false };
			lanes.set(key, lane);
			roundRobin.push(key);
			send({ type: "lane_state", generation, rootAgentId, rootSessionId, pending: true });
		}
		return lane;
	};

	const removeEmptyLane = (key: string, lane: Lane): void => {
		if (lane.entries.length !== 0) return;
		send({
			type: "lane_state",
			generation,
			rootAgentId: lane.rootAgentId,
			rootSessionId: lane.rootSessionId,
			pending: false,
		});
		lanes.delete(key);
		const index = roundRobin.indexOf(key);
		if (index >= 0) roundRobin.splice(index, 1);
		if (rrCursor >= roundRobin.length) rrCursor = 0;
		for (const candidate of lanes.values()) candidate.blocked = false;
	};

	const parseEntry = (entry: QueueEntry): IrcObserverRecordV1 => JSON.parse(entry.json) as IrcObserverRecordV1;
	const pump = (): void => {
		if (!worker || inFlight || !connectionNonce || !viewerOnline || roundRobin.length === 0) return;
		for (let count = 0; count < roundRobin.length; count++) {
			if (rrCursor >= roundRobin.length) rrCursor = 0;
			const key = roundRobin[rrCursor++];
			const lane = key ? lanes.get(key) : undefined;
			const head = lane?.entries[0];
			if (!lane || !head || lane.blocked) continue;
			inFlight = { laneKey: key, eventId: head.eventId };
			send({ type: "publish", generation, record: parseEntry(head) });
			return;
		}
	};

	const makeEntry = (record: IrcObserverRecordV1): QueueEntry | undefined => {
		const json = JSON.stringify(record);
		const bytes = encoder.encode(json).byteLength;
		if (bytes > IRC_OBSERVER_MAX_RECORD_BYTES) return undefined;
		return {
			json,
			bytes,
			eventId: record.eventId,
			sequenceStart: record.schema === "omp.irc.message.v1" ? record.sequence : record.sequenceStart,
			sequenceEnd: record.schema === "omp.irc.message.v1" ? record.sequence : record.sequenceEnd,
			droppedCount: record.schema === "omp.irc.message.v1" ? 1 : record.droppedCount,
			droppedBytes: record.schema === "omp.irc.message.v1" ? bytes : record.droppedBytes,
			isGap: record.schema === "omp.irc.gap.v1",
		};
	};

	const gapFor = (
		entry: QueueEntry,
		rootAgentId: string,
		rootSessionId: string,
		reason: IrcObserverGapRecordV1["reason"],
	): QueueEntry => {
		const record: IrcObserverGapRecordV1 = {
			schema: "omp.irc.gap.v1",
			eventId: `${processInstanceId}:gap:${entry.sequenceStart}-${entry.sequenceEnd}`,
			processInstanceId,
			processLabel,
			rootAgentId,
			rootSessionId,
			sequenceStart: entry.sequenceStart,
			sequenceEnd: entry.sequenceEnd,
			droppedCount: entry.droppedCount,
			droppedBytes: entry.droppedBytes,
			reason,
			certainty: "not_sent",
			exactRange: entry.sequenceEnd - entry.sequenceStart + 1 === entry.droppedCount,
		};
		return makeEntry(record) as QueueEntry;
	};

	const flushEmergencyGap = (): void => {
		if (!emergencyGap) return;
		const snapshot = emergencyGap;
		const record: IrcObserverGapRecordV1 = {
			schema: "omp.irc.gap.v1",
			eventId: `${processInstanceId}:gap:${snapshot.sequenceStart}-${snapshot.sequenceEnd}`,
			processInstanceId,
			processLabel,
			rootAgentId: "unresolved",
			rootSessionId: "unresolved",
			sequenceStart: snapshot.sequenceStart,
			sequenceEnd: snapshot.sequenceEnd,
			droppedCount: snapshot.droppedCount,
			droppedBytes: snapshot.droppedBytes,
			reason: "gap_metadata_overflow",
			certainty: "not_sent",
			exactRange: false,
		};
		const entry = makeEntry(record);
		if (
			!entry ||
			queuedRecords + 1 > IRC_OBSERVER_MAX_QUEUE_RECORDS ||
			queuedBytes + entry.bytes > IRC_OBSERVER_MAX_QUEUE_BYTES
		)
			return;
		emergencyGap = undefined;
		getLane("unresolved", "unresolved").entries.push(entry);
		queuedRecords++;
		queuedBytes += entry.bytes;
	};

	const accumulateEmergencyGap = (entry: QueueEntry): void => {
		emergencyGap = emergencyGap
			? {
					sequenceStart: Math.min(emergencyGap.sequenceStart, entry.sequenceStart),
					sequenceEnd: Math.max(emergencyGap.sequenceEnd, entry.sequenceEnd),
					droppedCount: emergencyGap.droppedCount + entry.droppedCount,
					droppedBytes: emergencyGap.droppedBytes + entry.droppedBytes,
				}
			: {
					sequenceStart: entry.sequenceStart,
					sequenceEnd: entry.sequenceEnd,
					droppedCount: entry.droppedCount,
					droppedBytes: entry.droppedBytes,
				};
	};

	const evictOldest = (): boolean => {
		let selected: { key: string; lane: Lane; index: number; entry: QueueEntry } | undefined;
		for (const [key, lane] of lanes) {
			for (let index = 0; index < lane.entries.length; index++) {
				const entry = lane.entries[index];
				if (!entry || (index === 0 && inFlight?.laneKey === key)) continue;
				if (!selected || entry.sequenceStart < selected.entry.sequenceStart) selected = { key, lane, index, entry };
				break;
			}
		}
		if (!selected) return false;
		selected.lane.entries.splice(selected.index, 1);
		queuedBytes -= selected.entry.bytes;
		queuedRecords--;
		accumulateEmergencyGap(selected.entry);
		removeEmptyLane(selected.key, selected.lane);
		return true;
	};

	const enqueue = (record: IrcObserverRecordV1): void => {
		let entry = makeEntry(record);
		if (!entry && record.schema === "omp.irc.message.v1") {
			const bodyBytes = encoder.encode(record.body).byteLength;
			entry = gapFor(
				{
					json: "",
					bytes: bodyBytes,
					eventId: record.eventId,
					sequenceStart: record.sequence,
					sequenceEnd: record.sequence,
					droppedCount: 1,
					droppedBytes: bodyBytes,
					isGap: false,
				},
				record.rootAgentId,
				record.rootSessionId,
				"record_oversize",
			);
		}
		if (!entry) return;
		while (
			queuedRecords + 1 > IRC_OBSERVER_MAX_QUEUE_RECORDS ||
			queuedBytes + entry.bytes > IRC_OBSERVER_MAX_QUEUE_BYTES
		) {
			if (!evictOldest()) {
				accumulateEmergencyGap(entry);
				return;
			}
		}
		const lane = getLane(record.rootAgentId, record.rootSessionId);
		lane.entries.push(entry);
		queuedRecords++;
		queuedBytes += entry.bytes;
		pump();
	};

	const observe = (event: IrcMessageCreatedEvent): void => {
		sequence++;
		const resolved = index.resolveMessageSession(event.message);
		const rootAgentId = resolved?.rootAgentId ?? "unresolved";
		const rootSessionId = resolved?.rootSessionId ?? "unresolved";
		const record: IrcObserverMessageRecordV1 = {
			schema: "omp.irc.message.v1",
			eventId: `${processInstanceId}:${sequence}`,
			processInstanceId,
			processLabel,
			rootAgentId,
			rootSessionId,
			...(resolved?.rootSessionLabel ? { rootSessionLabel: resolved.rootSessionLabel } : {}),
			sequence,
			messageId: event.message.id,
			origin: event.origin,
			from: event.message.from,
			to: event.message.to,
			...(event.message.replyTo ? { replyTo: event.message.replyTo } : {}),
			createdAt: event.message.ts,
			body: event.message.body,
		};
		enqueue(record);
		if (quietTimer) {
			clearTimeout(quietTimer);
			quietTimer = setTimeout(() => undefined, 100);
		}
	};
	const unsubscribeBus = bus.observeMessages(observe);

	const handleMessage = (message: IrcObserverWorkerOutbound): void => {
		if (message.type === "pong") {
			if (message.id === heartbeatId) {
				heartbeatMisses = 0;
				heartbeatId = undefined;
			}
			return;
		}
		if (!("generation" in message) || message.generation !== generation) return;
		if (message.type === "state" && message.code === "stopped") {
			workerStopped = true;
			return;
		}
		if (message.type === "state") {
			if (message.code !== "connecting") reportDegraded(message.code);
			return;
		}
		if (message.type === "booted") {
			clearTimeout(startupTimer);
			for (const lane of lanes.values())
				send({
					type: "lane_state",
					generation,
					rootAgentId: lane.rootAgentId,
					rootSessionId: lane.rootSessionId,
					pending: true,
				});
			return;
		}
		if (message.type === "connected") {
			connectionNonce = message.connectionNonce;
			viewerOnline = false;
			inFlight = undefined;
			return;
		}
		if (message.type === "viewer" && message.connectionNonce === connectionNonce) {
			viewerOnline = message.online;
			if (viewerOnline) pump();
			if (viewerOnline && queuedRecords === 0) reportRecovered();
			return;
		}
		if (
			message.type === "blocked" &&
			message.connectionNonce === connectionNonce &&
			message.eventId === inFlight?.eventId
		) {
			const lane = lanes.get(inFlight.laneKey);
			if (lane && message.code === "channel_not_ready") lane.blocked = true;
			if (message.code === "viewer_offline") viewerOnline = false;
			if (message.code === "viewer_offline") reportDegraded("viewer_offline");
			inFlight = undefined;
			pump();
			return;
		}
		if (
			message.type === "acked" &&
			message.connectionNonce === connectionNonce &&
			message.eventId === inFlight?.eventId
		) {
			const key = inFlight.laneKey;
			const lane = lanes.get(key);
			const head = lane?.entries[0];
			if (!lane || head?.eventId !== message.eventId) return;
			lane.entries.shift();
			queuedBytes -= head.bytes;
			queuedRecords--;
			inFlight = undefined;
			removeEmptyLane(key, lane);
			flushEmergencyGap();
			reportRecovered();
			pump();
		}
	};

	const scheduleSpawn = (code: "spawn_failed" | "heartbeat_timeout" | "worker_exit"): void => {
		if (stopping || respawnTimer) return;
		reportDegraded(code);
		connectionNonce = undefined;
		viewerOnline = false;
		inFlight = undefined;
		const cap = Math.min(250 * 2 ** respawnAttempt++, 30_000);
		respawnTimer = setTimeout(
			() => {
				respawnTimer = undefined;
				spawn();
			},
			cap / 2 + Math.random() * (cap / 2),
		);
		respawnTimer.unref?.();
	};

	const spawn = (): void => {
		const spawnCommand = resolveWorkerSpawnCmd(IRC_OBSERVER_WORKER_ARG);
		if (!spawnCommand.cwd) spawnCommand.cwd = os.tmpdir();
		try {
			const current = createWorkerSubprocess<IrcObserverWorkerOutbound>({
				spawnCommand,
				env: ircObserverWorkerEnv(),
				exitLabel: "IRC observer worker",
			});
			const currentWorker = createWorkerHandle(current, message => current.proc.send(message));
			worker = currentWorker;
			let failed = false;
			const fail = (code: "worker_exit" | "spawn_failed"): void => {
				if (failed || stopping || worker !== currentWorker) return;
				failed = true;
				worker = undefined;
				void currentWorker.terminate();
				scheduleSpawn(code);
			};
			currentWorker.onMessage(handleMessage);
			currentWorker.onError(() => fail("worker_exit"));
			void current.proc.exited.then(
				() => fail("worker_exit"),
				() => fail("worker_exit"),
			);
			currentWorker.send({ type: "init", version: IRC_OBSERVER_PROTOCOL_VERSION, generation, config });
			clearTimeout(startupTimer);
			startupTimer = setTimeout(() => fail("worker_exit"), 5_000);
			startupTimer.unref?.();
		} catch {
			scheduleSpawn("spawn_failed");
		}
	};
	spawn();
	heartbeatTimer = setInterval(() => {
		if (heartbeatId) heartbeatMisses++;
		if (heartbeatMisses >= 3) {
			void worker?.terminate();
			worker = undefined;
			scheduleSpawn("heartbeat_timeout");
			heartbeatMisses = 0;
		}
		heartbeatId = Bun.randomUUIDv7();
		send({ type: "ping", id: heartbeatId });
	}, 5_000);
	heartbeatTimer.unref?.();

	const stop = (mode: "normal" | "postmortem"): Promise<void> => {
		if (stopPromise) return stopPromise;
		stopPromise = (async () => {
			stopping = true;
			if (mode === "normal") {
				unsubscribeBus();
				index.dispose();
			}
			const deadline = performance.now() + 2_000;
			if (mode === "postmortem") await Bun.sleep(100);
			while ((queuedRecords > 0 || inFlight) && performance.now() < deadline) await Bun.sleep(10);
			if (mode === "postmortem") {
				unsubscribeBus();
				index.dispose();
			}
			workerStopped = false;
			if (worker) send({ type: "stop", generation });
			while (worker && !workerStopped && performance.now() < deadline) await Bun.sleep(10);
			clearInterval(heartbeatTimer);
			clearTimeout(quietTimer);
			clearTimeout(respawnTimer);
			clearTimeout(startupTimer);
			await worker?.terminate();
			worker = undefined;
		})();
		return stopPromise;
	};

	return {
		bindTopLevel(agentId, session) {
			if (stopping) return;
			index.bindTopLevel(agentId, session);
		},
		stop,
	};
}
