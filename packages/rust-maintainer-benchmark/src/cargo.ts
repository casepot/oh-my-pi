import * as path from "node:path";

export interface CargoCommandResult {
	name: string;
	args: string[];
	exitCode: number | null;
	stdout: string;
	stderr: string;
	duration: number;
	timedOut: boolean;
}

export interface RunCargoCommandOptions {
	name: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	targetDir: string;
}

async function streamToText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	return new Response(stream).text();
}

function processEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}

export async function resolveCargoBinary(): Promise<string> {
	try {
		const proc = Bun.spawn(["rustup", "which", "cargo"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const stdout = streamToText(proc.stdout as ReadableStream<Uint8Array> | null);
		const exitCode = await proc.exited;
		const resolved = (await stdout).trim();
		if (exitCode === 0 && resolved !== "") return resolved;
	} catch {
		return "cargo";
	}
	return "cargo";
}

export async function runCargoCommand(options: RunCargoCommandOptions): Promise<CargoCommandResult> {
	const start = performance.now();
	const cargoBinary = await resolveCargoBinary();
	const argv = [cargoBinary, ...options.args];
	const env = processEnv();
	const toolchainBin = path.dirname(cargoBinary);
	const pathSep = process.platform === "win32" ? ";" : ":";
	const currentPath = env.PATH ?? env.Path ?? "";
	env.PATH = currentPath === "" ? toolchainBin : `${toolchainBin}${pathSep}${currentPath}`;
	env.CARGO_TERM_COLOR = "never";
	env.CARGO_TARGET_DIR = options.targetDir;

	const proc = Bun.spawn(argv, {
		cwd: options.cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = streamToText(proc.stdout as ReadableStream<Uint8Array> | null);
	const stderr = streamToText(proc.stderr as ReadableStream<Uint8Array> | null);
	const timeout = Promise.withResolvers<"timeout">();
	let timedOut = false;
	const timeoutId = setTimeout(() => {
		timedOut = true;
		proc.kill();
		timeout.resolve("timeout");
	}, options.timeoutMs);
	timeoutId.unref?.();

	const racedExitCode = await Promise.race([proc.exited, timeout.promise]);
	let exitCode: number | null;
	if (racedExitCode === "timeout") {
		try {
			proc.kill("SIGKILL");
		} catch {
			// Process may already have exited after the first signal.
		}
		exitCode = await proc.exited.catch(() => null);
	} else {
		exitCode = racedExitCode;
	}
	clearTimeout(timeoutId);

	return {
		name: options.name,
		args: options.args,
		exitCode,
		stdout: await stdout,
		stderr: await stderr,
		duration: performance.now() - start,
		timedOut,
	};
}
