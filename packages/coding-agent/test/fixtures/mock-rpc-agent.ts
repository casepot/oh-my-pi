#!/usr/bin/env bun
/**
 * Test fixture: a stand-in for the coding-agent RPC mode.
 *
 * Emits the `ready` frame immediately, echoes each inbound command with a
 * success response, and stays alive until stdin closes or SIGTERM arrives.
 * Used by rpc-client lifecycle tests that need to exercise start/stop/start
 * without booting the full agent runtime (which requires provider credentials).
 */
const send = (frame: Record<string, unknown>) => {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
};

send({ type: "ready" });

let operationSeq = 0;

// Bun's `console` is an AsyncIterable over stdin lines.
for await (const raw of console) {
	if (!raw) continue;
	try {
		const frame = JSON.parse(raw) as Record<string, unknown>;
		if (!frame || typeof frame !== "object" || typeof frame.type !== "string") continue;
		const id = typeof frame.id === "string" ? frame.id : undefined;

		if (frame.type === "bash" || frame.type === "prompt") {
			const operationId = `op_mock_${++operationSeq}`;
			send({
				id,
				type: "response",
				command: frame.type,
				success: true,
				data: { ack: "accepted", operationId },
			});
			send({ type: "operation_start", operationId, command: frame.type });
			continue;
		}

		send({
			id,
			type: "response",
			command: frame.type,
			success: true,
			data: {},
		});
	} catch {
		// ignore parse errors — the test harness sends well-formed frames.
	}
}
process.exit(0);
