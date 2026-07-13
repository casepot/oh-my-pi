import * as path from "node:path";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { ircObserverWorkerEnv } from "./env";
import { IRC_OBSERVER_WORKER_ARG, type IrcObserverWorkerInbound, type IrcObserverWorkerOutbound } from "./protocol";

const SMOKE_TIMEOUT_MS = 30_000;

function executablePath(): string {
	const executable = process.execPath;
	return process.platform === "win32" && executable.startsWith("\\\\?\\") ? executable.slice(4) : executable;
}

function workerCommand(): { cmd: string[]; cwd?: string } {
	const executable = executablePath();
	if (process.env.PI_COMPILED === "true") return { cmd: [executable, IRC_OBSERVER_WORKER_ARG] };
	const hostEntry = workerHostEntry();
	if (hostEntry) {
		return {
			cmd: [executable, path.basename(hostEntry), IRC_OBSERVER_WORKER_ARG],
			cwd: path.dirname(hostEntry),
		};
	}
	const packageRoot = path.resolve(import.meta.dir, "..", "..", "..");
	return { cmd: [executable, "src/cli.ts", IRC_OBSERVER_WORKER_ARG], cwd: packageRoot };
}

export async function smokeTestIrcObserverWorker(): Promise<void> {
	const spawn = workerCommand();
	const id = Bun.randomUUIDv7();
	const completed = Promise.withResolvers<void>();
	let intentionalExit = false;
	const proc = Bun.spawn({
		cmd: spawn.cmd,
		cwd: spawn.cwd ?? path.dirname(process.execPath),
		env: ircObserverWorkerEnv(),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "inherit",
		serialization: "advanced",
		windowsHide: true,
		ipc(message) {
			const outbound = message as IrcObserverWorkerOutbound;
			if (outbound.type === "pong" && outbound.id === id) completed.resolve();
		},
		onExit(_proc, exitCode, signalCode) {
			if (intentionalExit) return;
			const reason = exitCode !== null ? `code ${exitCode}` : `signal ${signalCode ?? "unknown"}`;
			completed.reject(new Error(`IRC observer smoke worker exited with ${reason}`));
		},
	});
	const timer = setTimeout(() => completed.reject(new Error("IRC observer smoke worker timed out")), SMOKE_TIMEOUT_MS);
	try {
		proc.send({ type: "ping", id } satisfies IrcObserverWorkerInbound);
		await completed.promise;
	} finally {
		clearTimeout(timer);
		intentionalExit = true;
		if (proc.exitCode === null) proc.kill();
		await proc.exited;
	}
}
