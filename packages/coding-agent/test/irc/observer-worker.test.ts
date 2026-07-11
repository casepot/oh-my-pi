import { describe, expect, it } from "bun:test";
import type {
	IrcObserverMessageRecordV1,
	IrcObserverWorkerConfig,
	IrcObserverWorkerInbound,
	IrcObserverWorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/irc/observer/protocol";
import {
	escapeIrcObserverText,
	observerChannel,
	startIrcObserverWorker,
} from "@oh-my-pi/pi-coding-agent/irc/observer/worker";

function config(processInstanceId: string): IrcObserverWorkerConfig {
	return {
		endpoint: { hostname: "127.0.0.1", port: 6697, tls: true, caPem: "certificate" },
		identity: {
			processInstanceId,
			processLabel: "Long Project Label",
			publisherNick: "omp-p-0123456789abcdef01234567",
		},
		auth: {
			account: "omp-publisher",
			password: "secret",
			operName: "omp-observer",
			operPassword: "oper-secret",
			viewerNick: "omp-viewer",
		},
	};
}

function record(processInstanceId: string): IrcObserverMessageRecordV1 {
	return {
		schema: "omp.irc.message.v1",
		eventId: `${processInstanceId}:1`,
		processInstanceId,
		processLabel: "Long Project Label",
		rootAgentId: "Main/Unsafe Root",
		rootSessionId: "persisted-session",
		sequence: 1,
		messageId: "message-id",
		origin: "tool",
		from: "Main",
		to: "child",
		createdAt: 1,
		body: "body",
	};
}

describe("IRC observer rendering", () => {
	it("uses bounded process-incarnated session channels", () => {
		const first = observerChannel(
			config("018f0000-0000-7000-8000-000000000001"),
			record("018f0000-0000-7000-8000-000000000001"),
		);
		const second = observerChannel(
			config("018f0000-0000-7000-8000-000000000002"),
			record("018f0000-0000-7000-8000-000000000002"),
		);
		expect(first.length).toBeLessThanOrEqual(59);
		expect(first).toMatch(/^#omp-long-project-main-uns-[a-f0-9]{32}$/u);
		expect(second).not.toBe(first);
	});

	it("routes unresolved traffic to one process-scoped unscoped channel", () => {
		const value = record("018f0000-0000-7000-8000-000000000001");
		const unresolved = { ...value, rootAgentId: "unresolved", rootSessionId: "unresolved" };
		expect(observerChannel(config(value.processInstanceId), unresolved)).toMatch(
			/^#omp-long-project-unscoped-[a-f0-9]{24}$/u,
		);
	});

	it("escapes IRC controls and formatting characters without emitting raw bytes", () => {
		const escaped = escapeIrcObserverText("a\\b\r\n\0\u001b\u202eb");
		expect(escaped).toBe("a\\\\b\\r\\n\\0\\u{1b}\\u{202e}b");
		expect(escaped).not.toMatch(/[\r\n\0\u001b\u202e]/u);
	});

	it("registers over loopback TLS and ACKs echoed activity and NOTICE body records", async () => {
		const cert = await Bun.file("test/fixtures/irc-observer/server-cert.pem").text();
		const key = await Bun.file("test/fixtures/irc-observer/server-key.pem").text();
		const caPem = await Bun.file("test/fixtures/irc-observer/ca.pem").text();
		let received = "";
		const server = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			tls: { cert, key },
			socket: {
				open() {},
				data(socket, data) {
					received += new TextDecoder().decode(data);
					for (;;) {
						const boundary = received.indexOf("\r\n");
						if (boundary < 0) break;
						const line = received.slice(0, boundary);
						received = received.slice(boundary + 2);
						if (line === "CAP LS 302")
							socket.write(":ergo CAP * LS :sasl echo-message message-tags account-tag server-time\r\n");
						else if (line.startsWith("CAP REQ :"))
							socket.write(":ergo CAP * ACK :sasl echo-message message-tags account-tag server-time\r\n");
						else if (line === "AUTHENTICATE PLAIN") socket.write("AUTHENTICATE +\r\n");
						else if (line.startsWith("AUTHENTICATE ")) socket.write(":ergo 903 nick :SASL success\r\n");
						else if (line === "CAP END")
							socket.write(":ergo 005 nick MONITOR=100 CHANNELLEN=64 :supported\r\n:ergo 001 nick :welcome\r\n");
						else if (line.startsWith("OPER ")) socket.write(":ergo 381 nick :oper\r\n");
						else if (line.startsWith("MONITOR + "))
							socket.write(":ergo 730 nick :omp-viewer!viewer@localhost\r\n");
						else if (line.startsWith("MODE #")) {
							const channel = line.split(" ")[1];
							socket.write(`:ergo 324 nick ${channel} +imnst\r\n`);
						} else if (line.startsWith("NAMES #")) {
							const channel = line.split(" ")[1];
							socket.write(
								`:ergo 353 nick = ${channel} :@omp-p-0123456789abcdef01234567 omp-viewer\r\n:ergo 366 nick ${channel} :End of NAMES\r\n`,
							);
						} else if (line.startsWith("@+omp.sh/observer=")) {
							const separator = line.indexOf(" ");
							const tag = line.slice(1, separator);
							const command = line.slice(separator + 1);
							socket.write(
								`@${tag};account=omp-publisher :omp-p-0123456789abcdef01234567!u@localhost ${command}\r\n`,
							);
						}
					}
				},
				close() {},
				error() {},
			},
		});
		const handlers = new Set<(message: IrcObserverWorkerInbound) => void>();
		const connected = Promise.withResolvers<Extract<IrcObserverWorkerOutbound, { type: "connected" }>>();
		const viewer = Promise.withResolvers<Extract<IrcObserverWorkerOutbound, { type: "viewer" }>>();
		const acked = Promise.withResolvers<Extract<IrcObserverWorkerOutbound, { type: "acked" }>>();
		startIrcObserverWorker({
			send(message) {
				if (message.type === "connected") connected.resolve(message);
				if (message.type === "viewer" && message.online) viewer.resolve(message);
				if (message.type === "acked") acked.resolve(message);
			},
			async sendAndFlush() {},
			onMessage(handler) {
				handlers.add(handler);
				return () => handlers.delete(handler);
			},
		});
		const dispatch = (message: IrcObserverWorkerInbound): void => {
			for (const handler of handlers) handler(message);
		};
		const processInstanceId = "018f0000-0000-7000-8000-000000000001";
		const generation = "018f0000-0000-7000-8000-000000000099";
		const workerConfig = config(processInstanceId);
		dispatch({
			type: "init",
			version: 1,
			generation,
			config: { ...workerConfig, endpoint: { ...workerConfig.endpoint, port: server.port, caPem } },
		});
		const connection = await connected.promise;
		await viewer.promise;
		dispatch({
			type: "lane_state",
			generation,
			rootAgentId: "Main/Unsafe Root",
			rootSessionId: "persisted-session",
			pending: true,
		});
		dispatch({ type: "publish", generation, record: record(processInstanceId) });
		expect(await acked.promise).toEqual({
			type: "acked",
			generation,
			connectionNonce: connection.connectionNonce,
			eventId: `${processInstanceId}:1`,
		});
		dispatch({ type: "stop", generation });
		server.stop(true);
	});
});
