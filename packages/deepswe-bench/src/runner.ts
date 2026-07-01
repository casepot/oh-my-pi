#!/usr/bin/env bun
/**
 * DeepSWE runner for the local `omp` build.
 *
 * Orchestrates Pier (`pier run`) against a local DeepSWE task checkout using a
 * custom Pier agent (`agent/omp_pier_local.py`) that installs the working tree
 * or uploaded binary inside each task container and routes model auth through
 * the host `omp auth-gateway` by default.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ────────────────────────────────────────────────────────────────────── config

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const PKG_DIR = path.resolve(import.meta.dir, "..");
const AGENT_DIR = path.join(PKG_DIR, "agent");
const CODING_AGENT_DIR = path.join(REPO_ROOT, "packages", "coding-agent");
const AGENT_IMPORT_PATH = "omp_pier_local:OmpPierLocal";

const PRODUCT_LONG_PRESET = [
	"arcane-drift-detection-baselines",
	"fastapi-deprecation-response-headers",
	"updo-policy-alerting",
	"ofetch-per-origin-circuit-breaker",
	"kgateway-consistent-hash-policy",
	"prometheus-transactional-reload-status",
	"mnamer-daemon-watch-lifecycle",
	"clack-async-autocomplete-options",
	"effect-sse-httpapi-streaming",
	"drizzle-orm-window-function-builders",
] as const;

const SMOKE_FAST_PRESET = ["anko-default-function-arguments"] as const;

type InstallMode = "local" | "published" | "binary";

export interface Config {
	models: string[];
	tasksPath: string;
	nTasks: number | null;
	sampleSeed: number | null;
	includeTaskNames: string[];
	excludeTaskNames: string[];
	preset: "product-long" | "smoke-fast" | null;
	concurrency: number;
	attempts: number;
	thinking: string | null;
	advisorModel: string | null;
	advisorSync: string;
	agent: string;
	install: InstallMode;
	version: string | null;
	tarball: string | null;
	binaryArm64: string | null;
	binaryX64: string | null;
	build: boolean;
	jobsDir: string;
	jobName: string | null;
	gatewayUrl: string;
	gatewayToken: string;
	providers: string[];
	gateway: boolean;
	webSearch: boolean;
	allowFilteredGatewayPort: boolean;
	allowLowDisk: boolean;
	allowExistingJobDir: boolean;
	autoApprove: boolean;
	extraOmpArgs: string[];
	timeoutMultiplier: number | null;
	agentTimeoutMultiplier: number | null;
	verifierTimeoutMultiplier: number | null;
	environmentBuildTimeoutMultiplier: number | null;
	overrideCpus: number | null;
	overrideMemoryMb: number | null;
	overrideStorageMb: number | null;
	forceBuild: boolean | null;
	deleteEnvironment: boolean | null;
	yes: boolean;
	dryRun: boolean;
	reportOnly: boolean;
	reportJobDir: string | null;
	reportIntervalSec: number;
	passthrough: string[];
	env: Record<string, string>;
}

interface RunManifest {
	schemaVersion: 1;
	jobName: string;
	jobDir: string;
	benchDir: string;
	tasksPath: string;
	models: string[];
	agent: string;
	install: InstallMode;
	gateway: boolean;
	gatewayUrl: string | null;
	thinking: string | null;
	concurrency: number;
	attempts: number;
	includeTaskNames: string[];
	excludeTaskNames: string[];
	preset: Config["preset"];
	startedAt: string;
	pierArgs: string[];
	expected: number;
}

function defaultTasksPath(): string {
	const fromEnv = process.env.DEEPSWE_TASKS;
	if (fromEnv?.trim()) return resolveInputPath(fromEnv);
	return resolveInputPath("./deep-swe/tasks");
}

function defaultGatewayToken(): string {
	const fromEnv = process.env.OMP_AUTH_GATEWAY_TOKEN ?? process.env.PI_AUTH_GATEWAY_TOKEN;
	if (fromEnv?.trim()) return fromEnv.trim();
	const home = process.env.HOME;
	if (home) {
		try {
			const token = fs.readFileSync(path.join(home, ".omp", "auth-gateway.token"), "utf8").trim();
			if (token) return token;
		} catch {
			/* Gateway may be running in no-auth mode. */
		}
	}
	return "no-auth-dummy";
}

function defaultConfig(): Config {
	return {
		models: [],
		tasksPath: defaultTasksPath(),
		nTasks: null,
		sampleSeed: null,
		includeTaskNames: [],
		excludeTaskNames: [],
		preset: null,
		concurrency: 1,
		attempts: 1,
		thinking: "low",
		advisorModel: null,
		advisorSync: "1",
		agent: "omp",
		install: "local",
		version: null,
		tarball: null,
		binaryArm64: null,
		binaryX64: null,
		build: true,
		jobsDir: path.join(REPO_ROOT, "runs", "deepswe"),
		jobName: null,
		gatewayUrl: "http://host.docker.internal:4000",
		gatewayToken: defaultGatewayToken(),
		providers: [],
		gateway: true,
		webSearch: false,
		allowFilteredGatewayPort: false,
		allowLowDisk: false,
		allowExistingJobDir: false,
		autoApprove: true,
		extraOmpArgs: [],
		timeoutMultiplier: null,
		agentTimeoutMultiplier: null,
		verifierTimeoutMultiplier: null,
		environmentBuildTimeoutMultiplier: null,
		overrideCpus: null,
		overrideMemoryMb: null,
		overrideStorageMb: null,
		forceBuild: null,
		deleteEnvironment: null,
		yes: true,
		dryRun: false,
		reportOnly: false,
		reportJobDir: null,
		reportIntervalSec: 30,
		passthrough: [],
		env: {},
	};
}

const HELP = `DeepSWE runner (local omp via Pier)

Usage: bun src/runner.ts [options] [-- <extra pier args>]

Model / agent:
  -m, --model <provider/model>        Model (repeatable). Default openai-codex/gpt-5.5
      --agent <name>                  omp (default) | oracle | nop | any Pier agent
      --install <local|published|binary>
                                      local = pack packages/coding-agent (default)
      --version <v>                   omp version for published install (default: package version/latest)
      --thinking <level>              off|minimal|low|medium|high|xhigh (default low)
      --advisor-model <provider/model> Second model reviewing the primary; spend summed in
      --advisor-sync <off|1|3|5>      Advisor catch-up backlog (default 1)
      --tarball <path>                Reuse a prebuilt omp tarball (implies --no-build)
      --no-build                      Skip packing; reuse newest tarball in bench dir
      --binary <path>                 Upload self-contained omp binary; infer arch from filename
      --binary-arm64 <path>           Upload arm64 binary for --install binary
      --binary-x64 <path>             Upload x64 binary for --install binary
      --env <KEY[=VALUE]>             Forward env into in-container omp run (repeatable)
      --extra-omp-arg <arg>           Append a raw arg string to in-container omp command
      --no-auto-approve               Do not add --auto-approve to omp

Dataset / scale:
      --tasks-path <path>             DeepSWE tasks directory. Default ./deep-swe/tasks or DEEPSWE_TASKS
      --preset <product-long|smoke-fast> Include a built-in task set
  -l, --tasks, --n-tasks <N>          Max tasks after filters
      --sample-seed <N>               Pier deterministic task sample seed
  -n, --concurrency, --n-concurrent <N>
                                      Concurrent trials (default 1)
  -k, --attempts, --n-attempts <N>    Attempts per task (default 1)
  -i, --include-task-name <glob>      Include task name (repeatable)
  -x, --exclude-task-name <glob>      Exclude task name (repeatable)

Gateway (auth, no keys in container):
      --gateway-url <url>             Default http://host.docker.internal:4000
      --gateway-token <tok>           Default no-auth-dummy
      --providers <csv>               Providers to route (default: model/advisor providers)
      --gateway-provider <id>         Provider to route (repeatable)
      --no-gateway                    Pass host provider API keys into containers instead
      --web-search                    Enable omp web_search (off by default)
      --allow-filtered-gateway-port   Escape hatch for customized Pier proxies that allow gateway ports
      --allow-low-disk                Skip host/Docker backing disk space preflight

Reporting / recovery:
  -o, --jobs-dir <path>               Default <repo>/runs/deepswe
      --job-name <name>               Default deepswe-<model>-<timestamp>
      --report-only                   Rebuild report.md from an existing job and exit
      --job-dir <path>                Existing Pier job dir for --report-only
      --report-interval-sec <N>       Periodic report snapshot interval (default 30)
      --allow-existing-job-dir        Append to an existing job dir; dangerous for real runs

Pier passthrough / resources:
      --timeout-multiplier <f>        Scale all task timeouts
      --agent-timeout-multiplier <f>  Scale agent execution timeout
      --verifier-timeout-multiplier <f>
                                      Scale verifier timeout
      --environment-build-timeout-multiplier <f>
                                      Scale environment build timeout
      --override-cpus <N>             Override task CPU count
      --override-memory-mb <N>        Override task memory in MB
      --override-storage-mb <N>       Override task storage in MB
      --force-build / --no-force-build
                                      Force or skip environment rebuilds
      --delete / --no-delete          Delete or keep environments after completion
      --dry-run                       Print the pier command + models.yml and exit
  -h, --help                          This help
`;

// ───────────────────────────────────────────────────────────────── arg parsing

function resolveInputPath(input: string): string {
	const direct = path.resolve(input);
	if (fs.existsSync(direct)) return direct;
	if (input.startsWith("./") || input.startsWith("../")) {
		const fromRepo = path.resolve(REPO_ROOT, input);
		if (fs.existsSync(fromRepo)) return fromRepo;
	}
	return direct;
}

function parseNumber(flag: string, value: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a number`);
	return parsed;
}

function parsePositiveInt(flag: string, value: string): number {
	const parsed = parseNumber(flag, value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
	return parsed;
}

export function parseArgs(argv: string[]): Config | null {
	const cfg = defaultConfig();
	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i];
		if (arg === "--") {
			cfg.passthrough.push(...argv.slice(i + 1));
			break;
		}
		let inlineValue: string | null = null;
		const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
		if (eq !== -1) {
			inlineValue = arg.slice(eq + 1);
			arg = arg.slice(0, eq);
		}
		const take = (flag: string): string => {
			if (inlineValue !== null) return inlineValue;
			const v = argv[i + 1];
			if (v === undefined) throw new Error(`missing value for ${flag}`);
			i++;
			return v;
		};
		switch (arg) {
			case "-m":
			case "--model":
				cfg.models.push(take(arg));
				break;
			case "--agent":
				cfg.agent = take(arg);
				break;
			case "--install": {
				const v = take(arg);
				if (v !== "local" && v !== "published" && v !== "binary") {
					throw new Error("--install must be local|published|binary");
				}
				cfg.install = v;
				break;
			}
			case "--version":
				cfg.version = take(arg);
				break;
			case "--thinking":
				cfg.thinking = take(arg);
				break;
			case "--advisor-model":
				cfg.advisorModel = take(arg);
				break;
			case "--advisor-sync":
				cfg.advisorSync = take(arg);
				break;
			case "--tarball":
				cfg.tarball = path.resolve(take(arg));
				cfg.build = false;
				break;
			case "--binary": {
				const p = path.resolve(take(arg));
				const base = path.basename(p);
				if (/arm64|aarch64/.test(base)) cfg.binaryArm64 = p;
				else if (/x64|x86[_-]?64|amd64/.test(base)) cfg.binaryX64 = p;
				else throw new Error(`--binary: cannot infer arch from ${base} (expect arm64/x64 in filename)`);
				cfg.install = "binary";
				cfg.build = false;
				break;
			}
			case "--binary-arm64":
				cfg.binaryArm64 = path.resolve(take(arg));
				cfg.install = "binary";
				cfg.build = false;
				break;
			case "--binary-x64":
				cfg.binaryX64 = path.resolve(take(arg));
				cfg.install = "binary";
				cfg.build = false;
				break;
			case "--no-build":
				cfg.build = false;
				break;
			case "--tasks-path":
				cfg.tasksPath = resolveInputPath(take(arg));
				break;
			case "--preset": {
				const preset = take(arg);
				if (preset !== "product-long" && preset !== "smoke-fast") {
					throw new Error("--preset must be product-long|smoke-fast");
				}
				cfg.preset = preset;
				break;
			}
			case "-l":
			case "--tasks":
			case "--n-tasks":
				cfg.nTasks = parsePositiveInt(arg, take(arg));
				break;
			case "--sample-seed":
				cfg.sampleSeed = parsePositiveInt(arg, take(arg));
				break;
			case "-n":
			case "--concurrency":
			case "--n-concurrent":
				cfg.concurrency = parsePositiveInt(arg, take(arg));
				break;
			case "-k":
			case "--attempts":
			case "--n-attempts":
				cfg.attempts = parsePositiveInt(arg, take(arg));
				break;
			case "-i":
			case "--include":
			case "--include-task-name":
				cfg.includeTaskNames.push(take(arg));
				break;
			case "-x":
			case "--exclude":
			case "--exclude-task-name":
				cfg.excludeTaskNames.push(take(arg));
				break;
			case "--gateway-url":
				cfg.gatewayUrl = take(arg);
				break;
			case "--gateway-token":
				cfg.gatewayToken = take(arg);
				break;
			case "--providers":
				cfg.providers.push(
					...take(arg)
						.split(",")
						.map(s => s.trim())
						.filter(Boolean),
				);
				break;
			case "--gateway-provider":
				cfg.providers.push(take(arg));
				break;
			case "--no-gateway":
				cfg.gateway = false;
				break;
			case "--allow-filtered-gateway-port":
				cfg.allowFilteredGatewayPort = true;
				break;
			case "--allow-low-disk":
				cfg.allowLowDisk = true;
				break;
			case "--allow-existing-job-dir":
				cfg.allowExistingJobDir = true;
				break;
			case "--web-search":
				cfg.webSearch = true;
				break;
			case "--auto-approve":
				cfg.autoApprove = true;
				break;
			case "--no-auto-approve":
				cfg.autoApprove = false;
				break;
			case "--extra-omp-arg":
			case "--extra-omp-args":
				cfg.extraOmpArgs.push(take(arg));
				break;
			case "-o":
			case "--jobs-dir":
				cfg.jobsDir = path.resolve(take(arg));
				break;
			case "--job-name":
				cfg.jobName = take(arg);
				break;
			case "--timeout-multiplier":
				cfg.timeoutMultiplier = parseNumber(arg, take(arg));
				break;
			case "--agent-timeout-multiplier":
				cfg.agentTimeoutMultiplier = parseNumber(arg, take(arg));
				break;
			case "--verifier-timeout-multiplier":
				cfg.verifierTimeoutMultiplier = parseNumber(arg, take(arg));
				break;
			case "--environment-build-timeout-multiplier":
				cfg.environmentBuildTimeoutMultiplier = parseNumber(arg, take(arg));
				break;
			case "--override-cpus":
				cfg.overrideCpus = parsePositiveInt(arg, take(arg));
				break;
			case "--override-memory-mb":
				cfg.overrideMemoryMb = parsePositiveInt(arg, take(arg));
				break;
			case "--override-storage-mb":
				cfg.overrideStorageMb = parsePositiveInt(arg, take(arg));
				break;
			case "--force-build":
				cfg.forceBuild = true;
				break;
			case "--no-force-build":
				cfg.forceBuild = false;
				break;
			case "--delete":
				cfg.deleteEnvironment = true;
				break;
			case "--no-delete":
				cfg.deleteEnvironment = false;
				break;
			case "--dry-run":
				cfg.dryRun = true;
				break;
			case "--report-only":
				cfg.reportOnly = true;
				break;
			case "--job-dir":
				cfg.reportJobDir = path.resolve(take(arg));
				break;
			case "--report-interval-sec":
				cfg.reportIntervalSec = parsePositiveInt(arg, take(arg));
				break;
			case "-y":
			case "--yes":
				cfg.yes = true;
				break;
			case "-h":
			case "--help":
				process.stdout.write(HELP);
				return null;
			case "--env": {
				const spec = take(arg);
				const eq2 = spec.indexOf("=");
				if (eq2 === -1) {
					const hostVal = process.env[spec];
					if (hostVal !== undefined) cfg.env[spec] = hostVal;
				} else {
					cfg.env[spec.slice(0, eq2)] = spec.slice(eq2 + 1);
				}
				break;
			}
			default:
				throw new Error(`unknown flag: ${arg} (see --help)`);
		}
	}
	if (cfg.models.length === 0) cfg.models = ["openai-codex/gpt-5.5"];
	if (cfg.preset === "product-long") cfg.includeTaskNames.push(...PRODUCT_LONG_PRESET);
	if (cfg.preset === "smoke-fast") cfg.includeTaskNames.push(...SMOKE_FAST_PRESET);
	return cfg;
}

// ──────────────────────────────────────────────────────────────────── helpers

const isTTY = Boolean(process.stdout.isTTY);
const useColor = isTTY && !process.env.NO_COLOR;
const ESC = "\x1b[";
function c(code: string, s: string): string {
	return useColor ? `${ESC}${code}m${s}${ESC}0m` : s;
}
const dim = (s: string): string => c("2", s);
const bold = (s: string): string => c("1", s);
const green = (s: string): string => c("32", s);
const red = (s: string): string => c("31", s);
const yellow = (s: string): string => c("33", s);
const cyan = (s: string): string => c("36", s);
const gray = (s: string): string => c("90", s);

function fmtUsd(n: number): string {
	if (n >= 100) return `$${n.toFixed(0)}`;
	if (n >= 1) return `$${n.toFixed(2)}`;
	return `$${n.toFixed(3)}`;
}
function fmtNum(n: number): string {
	if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
	return `${n}`;
}
function fmtDur(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	return `${m}:${String(sec).padStart(2, "0")}`;
}
function bar(frac: number, width: number): string {
	const f = Math.max(0, Math.min(1, frac));
	const filled = Math.round(f * width);
	return "█".repeat(filled) + "░".repeat(width - filled);
}
function pad(s: string, w: number): string {
	return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}
function md(s: string): string {
	return s.replaceAll("|", "\\|").replaceAll("\n", " ");
}
function trunc(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function writeTextAtomic(file: string, text: string): void {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(tmp, text);
	fs.renameSync(tmp, file);
}

function appendRunnerLog(benchDir: string, message: string): void {
	try {
		fs.mkdirSync(benchDir, { recursive: true });
		fs.appendFileSync(path.join(benchDir, "runner.log"), `${new Date().toISOString()} ${message}\n`);
	} catch {
		/* Logging must never mask the runner's primary outcome. */
	}
}

// ───────────────────────────────────────────────────────────── task validation

interface TasksInfo {
	path: string;
	count: number;
	names: string[];
}

function validateTasksPath(tasksPath: string): TasksInfo {
	if (!fs.existsSync(tasksPath)) {
		throw new Error(
			`DeepSWE tasks path not found: ${tasksPath}. Clone https://github.com/datacurve-ai/deep-swe and pass --tasks-path <clone>/tasks.`,
		);
	}
	const stat = fs.statSync(tasksPath);
	if (!stat.isDirectory()) throw new Error(`DeepSWE tasks path is not a directory: ${tasksPath}`);
	if (fs.existsSync(path.join(tasksPath, "task.toml"))) {
		throw new Error(
			`--tasks-path points at a single task (${tasksPath}); pass the DeepSWE tasks directory and use --include-task-name ${path.basename(tasksPath)}.`,
		);
	}
	const names = fs
		.readdirSync(tasksPath, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && fs.existsSync(path.join(tasksPath, entry.name, "task.toml")))
		.map(entry => entry.name)
		.sort((a, b) => a.localeCompare(b));
	if (names.length === 0) throw new Error(`No DeepSWE task directories with task.toml found under ${tasksPath}`);
	return { path: tasksPath, count: names.length, names };
}

function fallbackExpectedTasks(cfg: Config, info: TasksInfo): number {
	if (cfg.nTasks !== null) return Math.min(cfg.nTasks, info.count);
	if (cfg.includeTaskNames.length > 0) return cfg.includeTaskNames.length;
	return info.count;
}

function taskNameMatches(pattern: string, name: string): boolean {
	if (!pattern.includes("*") && !pattern.includes("?")) return pattern === name;
	let source = "^";
	for (const ch of pattern) {
		if (ch === "*") {
			source += ".*";
		} else if (ch === "?") {
			source += ".";
		} else {
			source += ch.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
		}
	}
	return new RegExp(`${source}$`).test(name);
}

function taskSelectedByRunnerFilters(cfg: Config, name: string): boolean {
	const included =
		cfg.includeTaskNames.length === 0 || cfg.includeTaskNames.some(pattern => taskNameMatches(pattern, name));
	if (!included) return false;
	return !cfg.excludeTaskNames.some(pattern => taskNameMatches(pattern, name));
}

function gatewayPort(url: string): number {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("--gateway-url must be a valid URL");
	}
	if (parsed.port) return parsePositiveInt("--gateway-url port", parsed.port);
	if (parsed.protocol === "https:") return 443;
	if (parsed.protocol === "http:") return 80;
	throw new Error("--gateway-url must be a valid URL");
}

function taskHasFilteredAgentInternet(taskToml: string): boolean {
	let inEnvironment = false;
	for (const rawLine of taskToml.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*/, "").trim();
		if (!line) continue;
		const section = /^\[([^\]]+)\]$/.exec(line);
		if (section) {
			inEnvironment = section[1] === "environment";
			continue;
		}
		if (inEnvironment && /^allow_internet\s*=\s*false\b/.test(line)) return true;
	}
	return false;
}

function selectedFilteredTaskExamples(cfg: Config, maxExamples = 3): string[] {
	let names: string[] = [];
	try {
		names = fs
			.readdirSync(cfg.tasksPath, { withFileTypes: true })
			.filter(entry => entry.isDirectory() && fs.existsSync(path.join(cfg.tasksPath, entry.name, "task.toml")))
			.map(entry => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
	const selected = names.filter(name => taskSelectedByRunnerFilters(cfg, name));
	const limited = cfg.nTasks === null ? selected : selected.slice(0, cfg.nTasks);
	const examples: string[] = [];
	for (const name of limited) {
		try {
			const taskToml = fs.readFileSync(path.join(cfg.tasksPath, name, "task.toml"), "utf8");
			if (taskHasFilteredAgentInternet(taskToml)) examples.push(name);
		} catch {
			/* Ignore unreadable tasks; validateTasksPath already checked the dataset shape. */
		}
		if (examples.length >= maxExamples) break;
	}
	return examples;
}

function selectedTaskNames(cfg: Config): string[] {
	let names: string[] = [];
	try {
		names = fs
			.readdirSync(cfg.tasksPath, { withFileTypes: true })
			.filter(entry => entry.isDirectory() && fs.existsSync(path.join(cfg.tasksPath, entry.name, "task.toml")))
			.map(entry => entry.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
	const selected = names.filter(name => taskSelectedByRunnerFilters(cfg, name));
	return cfg.nTasks === null ? selected : selected.slice(0, cfg.nTasks);
}

function taskEnvironmentStorageMb(taskToml: string): number | null {
	let inEnvironment = false;
	for (const rawLine of taskToml.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*/, "").trim();
		if (!line) continue;
		const section = /^\[([^\]]+)\]$/.exec(line);
		if (section) {
			inEnvironment = section[1] === "environment";
			continue;
		}
		if (!inEnvironment) continue;
		const storage = /^storage_mb\s*=\s*([0-9]+(?:\.[0-9]+)?)\b/.exec(line);
		if (storage) return Math.ceil(parseNumber("storage_mb", storage[1]));
	}
	return null;
}

function formatMb(mb: number): string {
	return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GiB` : `${mb}MiB`;
}

function nearestExistingPath(target: string): string {
	let current = path.resolve(target);
	while (!fs.existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) return REPO_ROOT;
		current = parent;
	}
	return current;
}

function availableDiskMb(target: string): number | null {
	try {
		const stat = fs.statfsSync(nearestExistingPath(target));
		return Math.floor((Number(stat.bavail) * Number(stat.bsize)) / 1024 / 1024);
	} catch {
		return null;
	}
}

function selectedStoragePreflight(cfg: Config): {
	requiredMb: number;
	perTaskMb: number;
	concurrency: number;
	examples: string[];
} {
	const selected = selectedTaskNames(cfg);
	const concurrency = Math.min(cfg.concurrency, Math.max(1, selected.length));
	let perTaskMb = cfg.overrideStorageMb ?? 0;
	const examples: string[] = [];
	for (const name of selected) {
		try {
			const taskToml = fs.readFileSync(path.join(cfg.tasksPath, name, "task.toml"), "utf8");
			const storageMb = cfg.overrideStorageMb ?? taskEnvironmentStorageMb(taskToml) ?? 0;
			perTaskMb = Math.max(perTaskMb, storageMb);
			if (storageMb > 0 && examples.length < 3) examples.push(`${name}=${formatMb(storageMb)}`);
		} catch {
			/* Ignore unreadable tasks; validateTasksPath already checked the dataset shape. */
		}
	}
	return { requiredMb: perTaskMb * concurrency, perTaskMb, concurrency, examples };
}

function preflightHostStorage(cfg: Config): void {
	if (cfg.dryRun || cfg.allowLowDisk) return;
	const availableMb = availableDiskMb(cfg.jobsDir);
	if (availableMb === null) return;
	const storage = selectedStoragePreflight(cfg);
	if (storage.requiredMb <= 0) return;
	const bufferMb = 2048;
	if (storage.requiredMb + bufferMb <= availableMb) return;
	let message = `host/Docker backing disk has ${formatMb(availableMb)} free near ${nearestExistingPath(cfg.jobsDir)}, but selected DeepSWE tasks request ${formatMb(storage.requiredMb)} (${formatMb(storage.perTaskMb)} x concurrency ${storage.concurrency}) plus runner output space. Free Docker/host disk, pass --override-storage-mb <N> for local smoke runs, or pass --allow-low-disk to skip this preflight.`;
	if (storage.examples.length > 0) message += ` Examples: ${storage.examples.join(", ")}`;
	throw new Error(message);
}

function dirHasEntries(dir: string): boolean {
	try {
		return fs.readdirSync(dir).length > 0;
	} catch {
		return false;
	}
}

function ensureJobDirAvailable(cfg: Config, jobDir: string, benchDir: string): void {
	if (cfg.dryRun || cfg.allowExistingJobDir) return;
	if (dirHasEntries(jobDir)) {
		throw new Error(
			`job dir already exists and is not empty: ${jobDir}. Use a new --job-name, move/remove the old run, or pass --allow-existing-job-dir only when intentionally resuming/diagnosing.`,
		);
	}
	if (dirHasEntries(benchDir)) {
		throw new Error(
			`bench dir already exists and is not empty: ${benchDir}. Use a new --job-name, move/remove the old report artifacts, or pass --allow-existing-job-dir only when intentionally resuming/diagnosing.`,
		);
	}
}

function preflightGatewayPort(cfg: Config): void {
	if (!cfg.gateway) return;
	if (cfg.allowFilteredGatewayPort) return;
	const port = gatewayPort(cfg.gatewayUrl);
	if (port === 80 || port === 443) return;
	const examples = selectedFilteredTaskExamples(cfg);
	if (examples.length === 0) return;
	let message = `gateway URL ${cfg.gatewayUrl} uses port ${port}, but selected DeepSWE tasks use allow_internet=false and Pier's filtered egress proxy only allows HTTP/80 and HTTPS/443. Use --no-gateway with OPENAI_CODEX_OAUTH_TOKEN for local iteration, expose the gateway on 80/443, or pass --allow-filtered-gateway-port only if your Pier proxy has been customized.`;
	message += ` Examples: ${examples.join(", ")}`;
	throw new Error(message);
}

// ───────────────────────────────────────────────────────────── result parsing

type TrialStatus = "pass" | "fail" | "error" | "running";

interface Trial {
	name: string;
	status: TrialStatus;
	reward: number | null;
	f2p: number | null;
	p2p: number | null;
	partial: number | null;
	applyFailed: number | null;
	costUsd: number;
	advisorCostUsd: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
	durationMs: number;
	patchBytes: number | null;
	exceptionType: string | null;
	agentError: string | null;
	detail: string;
}

interface AgentCtxLike {
	n_input_tokens?: unknown;
	n_cache_tokens?: unknown;
	n_output_tokens?: unknown;
	cost_usd?: unknown;
	metadata?: unknown;
}

interface RewardsLike {
	reward?: number;
	f2p?: number;
	p2p?: number;
	partial?: number;
	apply_failed?: number;
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function optionalNum(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function readLiveUsage(ompLogPath: string): Pick<Trial, "costUsd" | "tokIn" | "tokOut" | "tokCache"> {
	let costUsd = 0;
	let tokIn = 0;
	let tokOut = 0;
	let tokCache = 0;
	if (!fs.existsSync(ompLogPath)) return { costUsd, tokIn, tokOut, tokCache };
	try {
		const content = fs.readFileSync(ompLogPath, "utf8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const event = JSON.parse(trimmed) as unknown;
				if (!event || typeof event !== "object") continue;
				const record = event as Record<string, unknown>;
				if (record.type !== "message_end") continue;
				const message = record.message;
				if (!message || typeof message !== "object") continue;
				const msg = message as Record<string, unknown>;
				if (msg.role !== "assistant") continue;
				const usage = msg.usage;
				if (!usage || typeof usage !== "object") continue;
				const u = usage as Record<string, unknown>;
				tokIn += num(u.input) + num(u.cacheRead);
				tokOut += num(u.output);
				tokCache += num(u.cacheRead);
				const cost = u.cost;
				if (cost && typeof cost === "object") costUsd += num((cost as Record<string, unknown>).total);
			} catch {
				/* Ignore malformed lines from incomplete writes. */
			}
		}
	} catch {
		/* ignore */
	}
	return { costUsd, tokIn, tokOut, tokCache };
}

function readAgentEndError(ompLogPath: string): string | null {
	let lastAgentEnd: Record<string, unknown> | null = null;
	if (!fs.existsSync(ompLogPath)) return null;
	try {
		const content = fs.readFileSync(ompLogPath, "utf8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const event = JSON.parse(trimmed) as unknown;
				if (!event || typeof event !== "object") continue;
				const record = event as Record<string, unknown>;
				if (record.type === "agent_end") lastAgentEnd = record;
			} catch {
				/* Ignore malformed lines from incomplete writes. */
			}
		}
	} catch {
		return null;
	}
	const messages = lastAgentEnd?.messages;
	if (!Array.isArray(messages)) return null;
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const msg = message as Record<string, unknown>;
		if (msg.role !== "assistant") continue;
		const errorMessage = msg.errorMessage;
		if (typeof errorMessage !== "string") continue;
		const trimmed = errorMessage.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

function collectRewards(vr: unknown): RewardsLike | null {
	if (!vr || typeof vr !== "object") return null;
	const rewards = (vr as Record<string, unknown>).rewards;
	if (!rewards || typeof rewards !== "object") return null;
	return rewards as RewardsLike;
}

function readRewards(trialDir: string, result: Record<string, unknown>): RewardsLike | null {
	let rewards = collectRewards(result.verifier_result);
	if (!rewards && Array.isArray(result.step_results)) {
		for (const st of result.step_results) {
			if (st && typeof st === "object")
				rewards = collectRewards((st as Record<string, unknown>).verifier_result) ?? rewards;
		}
	}
	if (rewards) return rewards;
	const raw = readJson(path.join(trialDir, "verifier", "reward.json"));
	return raw && typeof raw === "object" ? (raw as RewardsLike) : null;
}

function patchBytes(trialDir: string): number | null {
	try {
		const stat = fs.statSync(path.join(trialDir, "artifacts", "model.patch"));
		return stat.isFile() ? stat.size : null;
	} catch {
		return null;
	}
}

function verifierOutputLine(rawLine: string): string {
	const line = rawLine.trim();
	if (!line.startsWith("{")) return line;
	try {
		const event = JSON.parse(line) as Record<string, unknown>;
		if (typeof event.Output === "string") return event.Output.trim();
	} catch {
		/* Some verifier logs are plain text. */
	}
	return line;
}

function failureSummary(trialDir: string): string {
	const candidates = [path.join(trialDir, "verifier", "test-stdout.txt"), path.join(trialDir, "verifier", "run.log")];
	for (const file of candidates) {
		try {
			const lines = fs.readFileSync(file, "utf8").split("\n").map(verifierOutputLine).filter(Boolean);
			const interesting =
				lines.find(line => /\b(ERROR|FAIL|failed|reward|apply_failed)\b/i.test(line)) ?? lines.at(-1);
			if (interesting) return trunc(interesting, 160);
		} catch {
			/* ignore */
		}
	}
	return "";
}

function infrastructureFailureDetail(trialDir: string): string {
	const candidates = [path.join(trialDir, "trial.log"), path.join(trialDir, "exception.txt")];
	for (const file of candidates) {
		let content = "";
		try {
			content = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		if (/No space left on device/i.test(content)) return "infrastructure: no space left on device";
		if (/read-only file system/i.test(content)) return "infrastructure: Docker filesystem read-only";
		if (/input\/output error/i.test(content)) return "infrastructure: Docker input/output error";
		if (/Docker compose command failed/i.test(content)) return "infrastructure: Docker compose failed";
	}
	return "";
}

function normalizeExceptionDetail(exceptionType: string | null, exceptionMessage: unknown): string {
	if (typeof exceptionMessage === "string" && exceptionMessage.includes("exit 137")) return "agent killed (exit 137)";
	return exceptionType ?? "";
}

/** Parse one trial directory into a Trial, or null if it isn't a trial dir yet. */
function parseTrial(dir: string, name: string): Trial | null {
	const resultPath = path.join(dir, "result.json");
	if (!fs.existsSync(resultPath)) {
		let started = Date.now();
		try {
			started = fs.statSync(dir).mtimeMs;
		} catch {
			/* ignore */
		}
		const usage = readLiveUsage(path.join(dir, "agent", "omp.txt"));
		return {
			name,
			status: "running",
			reward: null,
			f2p: null,
			p2p: null,
			partial: null,
			applyFailed: null,
			costUsd: usage.costUsd,
			advisorCostUsd: 0,
			tokIn: usage.tokIn,
			tokOut: usage.tokOut,
			tokCache: usage.tokCache,
			durationMs: Date.now() - started,
			patchBytes: patchBytes(dir),
			detail: "",
			exceptionType: null,
			agentError: null,
		};
	}
	const raw = readJson(resultPath);
	if (!raw || typeof raw !== "object") return null;
	const result = raw as Record<string, unknown>;

	const ctxs: AgentCtxLike[] = [];
	if (result.agent_result && typeof result.agent_result === "object") ctxs.push(result.agent_result as AgentCtxLike);
	if (Array.isArray(result.step_results)) {
		for (const st of result.step_results) {
			if (st && typeof st === "object") {
				const ar = (st as Record<string, unknown>).agent_result;
				if (ar && typeof ar === "object") ctxs.push(ar as AgentCtxLike);
			}
		}
	}
	let costUsd = 0;
	let advisorCostUsd = 0;
	let tokIn = 0;
	let tokOut = 0;
	let tokCache = 0;
	for (const ctx of ctxs) {
		costUsd += num(ctx.cost_usd);
		tokIn += num(ctx.n_input_tokens);
		tokOut += num(ctx.n_output_tokens);
		tokCache += num(ctx.n_cache_tokens);
		if (ctx.metadata && typeof ctx.metadata === "object") {
			advisorCostUsd += num((ctx.metadata as Record<string, unknown>).advisor_cost_usd);
		}
	}

	const rewards = readRewards(dir, result);
	const reward = optionalNum(rewards?.reward);
	const exc =
		result.exception_info && typeof result.exception_info === "object"
			? (result.exception_info as Record<string, unknown>)
			: null;
	const exceptionType = typeof exc?.exception_type === "string" ? exc.exception_type : null;
	const exceptionDetail = normalizeExceptionDetail(exceptionType, exc?.exception_message ?? exc?.message);
	const agentError = readAgentEndError(path.join(dir, "agent", "omp.txt"));

	let durationMs = 0;
	const start = typeof result.started_at === "string" ? Date.parse(result.started_at) : NaN;
	const end = typeof result.finished_at === "string" ? Date.parse(result.finished_at) : NaN;
	if (Number.isFinite(start) && Number.isFinite(end)) durationMs = end - start;

	let status: TrialStatus;
	if (reward !== null) {
		status = reward >= 1 - 1e-9 ? "pass" : "fail";
	} else if (exc) {
		status = "error";
	} else {
		status = "fail";
	}
	const infraDetail = infrastructureFailureDetail(dir);
	let detail = agentError ? trunc(agentError, 160) : infraDetail || exceptionDetail || failureSummary(dir);
	if (status === "pass" && !agentError && !infraDetail && !exceptionDetail) detail = "";
	return {
		name,
		status,
		reward,
		f2p: optionalNum(rewards?.f2p),
		p2p: optionalNum(rewards?.p2p),
		partial: optionalNum(rewards?.partial),
		applyFailed: optionalNum(rewards?.apply_failed),
		costUsd,
		advisorCostUsd,
		tokIn,
		tokOut,
		tokCache,
		durationMs,
		patchBytes: patchBytes(dir),
		exceptionType,
		agentError,
		detail,
	};
}

function readTrials(jobDir: string): Trial[] {
	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(jobDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const trials: Trial[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const trial = parseTrial(path.join(jobDir, entry.name), entry.name);
		if (trial) trials.push(trial);
	}
	return trials;
}

interface JobInfo {
	nTotal: number;
	running: number | null;
	pending: number | null;
}

function readJobResult(jobDir: string): JobInfo | null {
	const raw = readJson(path.join(jobDir, "result.json"));
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const nTotal = typeof r.n_total_trials === "number" ? r.n_total_trials : 0;
	let running: number | null = null;
	let pending: number | null = null;
	if (r.stats && typeof r.stats === "object") {
		const stats = r.stats as Record<string, unknown>;
		if (typeof stats.n_running_trials === "number") running = stats.n_running_trials;
		if (typeof stats.n_pending_trials === "number") pending = stats.n_pending_trials;
	}
	return nTotal > 0 ? { nTotal, running, pending } : null;
}

// ──────────────────────────────────────────────────────────────────── totals

interface Totals {
	total: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	running: number;
	pending: number;
	costUsd: number;
	advisorCostUsd: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
}

function aggregate(trials: Trial[], job: JobInfo | null, fallbackExpected: number): Totals {
	const totals: Totals = {
		total: fallbackExpected,
		done: 0,
		pass: 0,
		fail: 0,
		error: 0,
		running: 0,
		pending: 0,
		costUsd: 0,
		advisorCostUsd: 0,
		tokIn: 0,
		tokOut: 0,
		tokCache: 0,
	};
	for (const trial of trials) {
		totals.costUsd += trial.costUsd;
		totals.advisorCostUsd += trial.advisorCostUsd;
		totals.tokIn += trial.tokIn;
		totals.tokOut += trial.tokOut;
		totals.tokCache += trial.tokCache;
		if (trial.status === "running") {
			totals.running++;
			continue;
		}
		totals.done++;
		if (trial.status === "pass") totals.pass++;
		else if (trial.status === "error") totals.error++;
		else totals.fail++;
	}
	totals.total = job ? job.nTotal : Math.max(fallbackExpected, trials.length);
	if (job?.running !== null && job?.running !== undefined) totals.running = job.running;
	totals.pending = Math.max(0, totals.total - totals.done - totals.running);
	return totals;
}

// ──────────────────────────────────────────────────────────────── dashboard IO

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function statusIcon(s: TrialStatus, tick: number): string {
	switch (s) {
		case "pass":
			return green("+");
		case "fail":
			return red("x");
		case "error":
			return yellow("!");
		case "running":
			return cyan(SPINNER[tick % SPINNER.length]);
	}
}

function tailFile(file: string, maxLines: number): string[] {
	try {
		const buf = fs.readFileSync(file, "utf8");
		const lines = buf.split("\n").filter(line => line.trim().length > 0);
		return lines.slice(-maxLines);
	} catch {
		return [];
	}
}

interface RenderState {
	cfg: Config;
	jobDir: string;
	logPath: string;
	startMs: number;
	expected: number;
	tick: number;
}

function render(st: RenderState): void {
	const trials = readTrials(st.jobDir);
	const totals = aggregate(trials, readJobResult(st.jobDir), st.expected);
	const elapsed = Date.now() - st.startMs;
	const rate = totals.done > 0 ? elapsed / totals.done : 0;
	const eta = rate > 0 && totals.done < totals.total ? rate * (totals.total - totals.done) : 0;
	const successPct = totals.done > 0 ? (totals.pass / totals.done) * 100 : 0;

	const rows: string[] = [];
	const advisorTag = st.cfg.advisorModel ? `${dim(" + advisor ")}${st.cfg.advisorModel}` : "";
	const presetTag = st.cfg.preset ? dim(` · preset=${st.cfg.preset}`) : "";
	const header = `${bold("DeepSWE")} ${dim("·")} ${cyan(st.cfg.agent)} ${dim("·")} ${st.cfg.models.join(",")}${advisorTag}${presetTag} ${dim(`· conc=${st.cfg.concurrency} k=${st.cfg.attempts}`)}`;
	rows.push(header);
	const width = 28;
	rows.push(
		`${bar(totals.total > 0 ? totals.done / totals.total : 0, width)} ${bold(`${totals.done}/${totals.total}`)}  ${dim("elapsed")} ${fmtDur(elapsed)}  ${dim("eta")} ${eta > 0 ? `~${fmtDur(eta)}` : "—"}`,
	);
	rows.push(
		`${green(`pass ${totals.pass}`)} ${dim(`(${successPct.toFixed(0)}%)`)}   ${red(`fail ${totals.fail}`)}   ${yellow(`err ${totals.error}`)}   ${cyan(`run ${totals.running}`)}   ${gray(`pend ${totals.pending}`)}`,
	);
	const advisorSpend = totals.advisorCostUsd > 0 ? dim(` (advisor ${fmtUsd(totals.advisorCostUsd)})`) : "";
	rows.push(
		`${bold("spend")} ${fmtUsd(totals.costUsd)}${advisorSpend}   ${dim("in")} ${fmtNum(totals.tokIn)}  ${dim("out")} ${fmtNum(totals.tokOut)}  ${dim("cache")} ${fmtNum(totals.tokCache)}`,
	);
	rows.push(dim("─".repeat(62)));

	const order: Record<TrialStatus, number> = { running: 0, error: 1, fail: 2, pass: 3 };
	const sorted = [...trials].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
	const maxRows = isTTY ? Math.max(6, (process.stdout.rows ?? 40) - rows.length - 4) : sorted.length;
	for (const trial of sorted.slice(0, maxRows)) {
		const rw = trial.reward !== null ? `r${trial.reward.toFixed(2)}` : trial.status === "running" ? "·" : "—";
		const parts = [
			rw,
			trial.f2p !== null ? `f${trial.f2p.toFixed(2)}` : "f—",
			fmtUsd(trial.costUsd),
			fmtDur(trial.durationMs),
		];
		const detail = trial.detail ? ` ${yellow(trial.detail)}` : "";
		rows.push(
			` ${statusIcon(trial.status, st.tick)} ${pad(trial.name, 34)} ${dim(parts.map(part => pad(part, 7)).join(" "))}${detail}`,
		);
	}
	if (sorted.length > maxRows) rows.push(dim(`  … ${sorted.length - maxRows} more`));
	rows.push(dim("─".repeat(62)));
	const lastLog = tailFile(st.logPath, 1)[0] ?? "";
	rows.push(gray(`pier: ${lastLog.slice(0, 80)}`));

	if (isTTY) {
		let out = `${ESC}H${ESC}J`;
		out += rows.join(`${ESC}K\n`);
		process.stdout.write(out);
	} else {
		process.stdout.write(
			`[deepswe] ${totals.done}/${totals.total} pass=${totals.pass}(${successPct.toFixed(0)}%) fail=${totals.fail} err=${totals.error} run=${totals.running} spend=${fmtUsd(totals.costUsd)} elapsed=${fmtDur(elapsed)}\n`,
		);
	}
}

// ────────────────────────────────────────────────────────────────────── report

function value(v: number | null, digits: number): string {
	return v === null ? "—" : v.toFixed(digits);
}

type ReportState = "running" | "complete" | "interrupted" | "error";

function presetTaskCount(preset: Config["preset"]): number {
	if (preset === "product-long") return PRODUCT_LONG_PRESET.length;
	if (preset === "smoke-fast") return SMOKE_FAST_PRESET.length;
	return 0;
}

function writeReport(st: RenderState, benchDir: string, state: ReportState, exitCode: number | null): string {
	const trials = readTrials(st.jobDir).sort((a, b) => a.name.localeCompare(b.name));
	const totals = aggregate(trials, readJobResult(st.jobDir), st.expected);
	const successPct = totals.done > 0 ? (totals.pass / totals.done) * 100 : 0;
	const lines: string[] = [];
	const isOmp = st.cfg.agent === "omp";
	const modelLine =
		isOmp && st.cfg.advisorModel
			? `${st.cfg.models.join(", ")} + advisor ${st.cfg.advisorModel}`
			: st.cfg.models.join(", ");
	lines.push(`# DeepSWE — ${st.cfg.agent} — ${modelLine}`);
	lines.push("");
	lines.push(`- status: ${state}`);
	lines.push(`- pier exit: ${exitCode === null ? "running" : exitCode}`);
	lines.push(`- tasks path: \`${st.cfg.tasksPath}\``);
	if (st.cfg.preset) lines.push(`- preset: \`${st.cfg.preset}\` (${presetTaskCount(st.cfg.preset)} tasks)`);
	lines.push(`- tasks: ${st.cfg.nTasks ?? "all"} · attempts: ${st.cfg.attempts} · concurrency: ${st.cfg.concurrency}`);
	if (st.cfg.includeTaskNames.length > 0)
		lines.push(`- include: ${st.cfg.includeTaskNames.map(item => `\`${item}\``).join(", ")}`);
	if (st.cfg.excludeTaskNames.length > 0)
		lines.push(`- exclude: ${st.cfg.excludeTaskNames.map(item => `\`${item}\``).join(", ")}`);
	if (isOmp) {
		lines.push(
			`- install: ${st.cfg.install} · auth: ${st.cfg.gateway ? "host gateway (no keys in container)" : "direct provider keys"}`,
		);
		lines.push(`- tools: web_search=${st.cfg.webSearch ? "on" : "off"}`);
		if (st.cfg.advisorModel) lines.push(`- advisor: ${st.cfg.advisorModel}`);
	}
	lines.push(`- elapsed: ${fmtDur(Date.now() - st.startMs)}`);
	lines.push("");
	const advisorSpend = totals.advisorCostUsd > 0 ? ` (advisor ${fmtUsd(totals.advisorCostUsd)})` : "";
	lines.push(
		`**${totals.pass}/${totals.done} passed (${successPct.toFixed(1)}%)** · fail ${totals.fail} · error ${totals.error} · spend ${fmtUsd(totals.costUsd)}${advisorSpend}`,
	);
	lines.push(`tokens: in ${fmtNum(totals.tokIn)} · out ${fmtNum(totals.tokOut)} · cache ${fmtNum(totals.tokCache)}`);
	lines.push("");
	lines.push(
		"| task | result | reward | f2p | p2p | partial | apply_failed | exception | cost | tokens in/cache/out | duration | patch bytes | detail |",
	);
	lines.push("|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---|");
	for (const trial of trials) {
		const res = trial.status;
		const tokens = `${fmtNum(trial.tokIn)}/${fmtNum(trial.tokCache)}/${fmtNum(trial.tokOut)}`;
		lines.push(
			`| ${md(trial.name)} | ${res} | ${value(trial.reward, 2)} | ${value(trial.f2p, 2)} | ${value(trial.p2p, 2)} | ${value(trial.partial, 2)} | ${value(trial.applyFailed, 0)} | ${md(trial.exceptionType ?? "—")} | ${fmtUsd(trial.costUsd)} | ${tokens} | ${fmtDur(trial.durationMs)} | ${trial.patchBytes ?? "—"} | ${md(trial.detail)} |`,
		);
	}
	lines.push("");
	const reportPath = path.join(benchDir, "report.md");
	writeTextAtomic(reportPath, lines.join("\n"));
	return reportPath;
}

function writeRunManifest(
	benchDir: string,
	jobName: string,
	jobDir: string,
	cfg: Config,
	pierArgs: string[],
	expected: number,
	startedAt: string,
): string {
	const manifest: RunManifest = {
		schemaVersion: 1,
		jobName,
		jobDir,
		benchDir,
		tasksPath: cfg.tasksPath,
		models: [...cfg.models],
		agent: cfg.agent,
		install: cfg.install,
		gateway: cfg.gateway,
		gatewayUrl: cfg.gateway ? cfg.gatewayUrl : null,
		thinking: cfg.thinking,
		concurrency: cfg.concurrency,
		attempts: cfg.attempts,
		includeTaskNames: [...cfg.includeTaskNames],
		excludeTaskNames: [...cfg.excludeTaskNames],
		preset: cfg.preset,
		startedAt,
		pierArgs: [...pierArgs],
		expected,
	};
	const file = path.join(benchDir, "run.json");
	writeTextAtomic(file, `${JSON.stringify(manifest, null, "\t")}\n`);
	return file;
}

function loadRunManifest(benchDir: string): RunManifest | null {
	const raw = readJson(path.join(benchDir, "run.json"));
	if (!raw || typeof raw !== "object") return null;
	if ((raw as Record<string, unknown>).schemaVersion !== 1) return null;
	return raw as RunManifest;
}

function cfgForReport(base: Config, manifest: RunManifest | null): Config {
	if (!manifest) return base;
	return {
		...base,
		models: [...manifest.models],
		tasksPath: manifest.tasksPath,
		includeTaskNames: [...manifest.includeTaskNames],
		excludeTaskNames: [...manifest.excludeTaskNames],
		preset: manifest.preset,
		concurrency: manifest.concurrency,
		attempts: manifest.attempts,
		thinking: manifest.thinking,
		agent: manifest.agent,
		install: manifest.install,
		jobName: manifest.jobName,
		gateway: manifest.gateway,
		gatewayUrl: manifest.gatewayUrl ?? base.gatewayUrl,
	};
}

function inferReportOnlyState(job: JobInfo | null, trials: Trial[], expected: number): ReportState {
	if (job) {
		const running = job.running ?? 0;
		const pending = job.pending ?? 0;
		if (running === 0 && pending === 0 && trials.length >= expected) return "complete";
		return "interrupted";
	}
	return trials.some(trial => trial.status === "running") ? "interrupted" : "complete";
}

function runReportOnly(cfg: Config): void {
	let jobDir = cfg.reportJobDir;
	if (!jobDir) {
		if (!cfg.jobName) throw new Error("--report-only requires --job-name or --job-dir");
		jobDir = path.join(cfg.jobsDir, cfg.jobName);
	}
	const benchDir = path.join(cfg.jobsDir, "_bench", cfg.jobName ?? path.basename(jobDir));
	const manifest = loadRunManifest(benchDir);
	const reportCfg = cfgForReport(cfg, manifest);
	const trials = readTrials(jobDir);
	if (trials.length === 0) throw new Error(`--report-only: no trial results found in ${jobDir}`);
	const job = readJobResult(jobDir);
	const expected = manifest?.expected ?? job?.nTotal ?? trials.length;
	const startedAt = manifest?.startedAt ? Date.parse(manifest.startedAt) : NaN;
	const st: RenderState = {
		cfg: reportCfg,
		jobDir,
		logPath: path.join(benchDir, "pier.log"),
		startMs: Number.isFinite(startedAt) ? startedAt : Date.now(),
		expected,
		tick: 0,
	};
	const state = inferReportOnlyState(job, trials, expected);
	const reportPath = writeReport(st, benchDir, state, state === "complete" ? 0 : null);
	appendRunnerLog(benchDir, `report-only wrote report ${reportPath} from ${jobDir}`);
	process.stdout.write(`${dim("report:")} ${reportPath}\n`);
	process.stdout.write(`${dim("manifest:")} ${path.join(benchDir, "run.json")}\n`);
	process.stdout.write(`${dim("runner log:")} ${path.join(benchDir, "runner.log")}\n`);
	process.stdout.write(`${dim("pier log:")} ${st.logPath}\n`);
	process.stdout.write(`${dim("trials:")} ${jobDir}\n`);
}

// ──────────────────────────────────────────────────────────────────── setup

function which(bin: string): string | null {
	const result = spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" });
	const out = result.stdout?.trim();
	return result.status === 0 && out ? out : null;
}

function readPkgVersion(): string {
	const raw = readJson(path.join(CODING_AGENT_DIR, "package.json"));
	if (raw && typeof raw === "object") {
		const version = (raw as Record<string, unknown>).version;
		if (typeof version === "string") return version;
	}
	return "latest";
}

function buildTarball(benchRoot: string): string {
	process.stdout.write(dim("packing local omp (bun pm pack)…\n"));
	fs.mkdirSync(benchRoot, { recursive: true });
	const result = spawnSync("bun", ["pm", "pack", "--destination", benchRoot], {
		cwd: CODING_AGENT_DIR,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		process.stderr.write((result.stdout ?? "") + (result.stderr ?? ""));
		throw new Error("bun pm pack failed");
	}
	const tgz = fs
		.readdirSync(benchRoot)
		.filter(file => file.endsWith(".tgz"))
		.map(file => ({ file, mtime: fs.statSync(path.join(benchRoot, file)).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)[0];
	if (!tgz) throw new Error("no .tgz produced by bun pm pack");
	return path.join(benchRoot, tgz.file);
}

function newestTarball(benchRoot: string): string | null {
	try {
		const tgz = fs
			.readdirSync(benchRoot)
			.filter(file => file.endsWith(".tgz"))
			.map(file => ({ file, mtime: fs.statSync(path.join(benchRoot, file)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime)[0];
		return tgz ? path.join(benchRoot, tgz.file) : null;
	} catch {
		return null;
	}
}

function modelProvider(model: string): string | null {
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(0, slash) : null;
}

function deriveProviders(cfg: Config): string[] {
	const set = new Set<string>(cfg.providers);
	for (const model of cfg.models) {
		const provider = modelProvider(model);
		if (provider) set.add(provider);
	}
	if (cfg.advisorModel) {
		const provider = modelProvider(cfg.advisorModel);
		if (provider) set.add(provider);
	}
	if (set.size === 0) set.add("openai-codex");
	return [...set];
}

function modelsYamlContent(cfg: Config, redact = false): string {
	const lines = ["# Generated by deepswe runner — auth via host omp auth-gateway.", "providers:"];
	for (const provider of deriveProviders(cfg)) {
		lines.push(`  ${provider}:`);
		lines.push(`    baseUrl: ${cfg.gatewayUrl}`);
		lines.push("    auth: oauth");
		lines.push("    transport: pi-native");
		const apiKey = redact ? "<redacted>" : cfg.gatewayToken;
		lines.push(`    apiKey: ${apiKey}`);
	}
	return `${lines.join("\n")}\n`;
}

function writeModelsYaml(benchDir: string, cfg: Config): string {
	const file = path.join(benchDir, "models.yml");
	fs.writeFileSync(file, modelsYamlContent(cfg));
	return file;
}

function gatewayHealthOk(url: string): boolean {
	const hostUrl = url.replace("host.docker.internal", "127.0.0.1").replace(/\/+$/, "");
	const result = spawnSync("curl", ["-s", "--max-time", "4", `${hostUrl}/healthz`], { encoding: "utf8" });
	return result.status === 0 && (result.stdout ?? "").includes('"ok":true');
}

function ensureDirectAuthIsPossible(cfg: Config): void {
	const needsCodex = cfg.models.some(model => modelProvider(model) === "openai-codex");
	const hasCodexToken = Boolean(process.env.OPENAI_CODEX_OAUTH_TOKEN || cfg.env.OPENAI_CODEX_OAUTH_TOKEN);
	if (!cfg.gateway && needsCodex && !hasCodexToken) {
		throw new Error(
			"openai-codex direct mode requires OPENAI_CODEX_OAUTH_TOKEN in the runner environment or --env OPENAI_CODEX_OAUTH_TOKEN=...",
		);
	}
}

function buildPierArgs(cfg: Config, jobName: string): string[] {
	const args: string[] = ["run", "-p", cfg.tasksPath, "-o", cfg.jobsDir, "--job-name", jobName];
	args.push("-n", String(cfg.concurrency), "-k", String(cfg.attempts));
	if (cfg.nTasks !== null) args.push("-l", String(cfg.nTasks));
	if (cfg.sampleSeed !== null) args.push("--sample-seed", String(cfg.sampleSeed));
	for (const model of cfg.models) args.push("--model", model);
	for (const include of cfg.includeTaskNames) args.push("--include-task-name", include);
	for (const exclude of cfg.excludeTaskNames) args.push("--exclude-task-name", exclude);
	if (cfg.timeoutMultiplier !== null) args.push("--timeout-multiplier", String(cfg.timeoutMultiplier));
	if (cfg.agentTimeoutMultiplier !== null) args.push("--agent-timeout-multiplier", String(cfg.agentTimeoutMultiplier));
	if (cfg.verifierTimeoutMultiplier !== null)
		args.push("--verifier-timeout-multiplier", String(cfg.verifierTimeoutMultiplier));
	if (cfg.environmentBuildTimeoutMultiplier !== null) {
		args.push("--environment-build-timeout-multiplier", String(cfg.environmentBuildTimeoutMultiplier));
	}
	if (cfg.overrideCpus !== null) args.push("--override-cpus", String(cfg.overrideCpus));
	if (cfg.overrideMemoryMb !== null) args.push("--override-memory-mb", String(cfg.overrideMemoryMb));
	if (cfg.overrideStorageMb !== null) args.push("--override-storage-mb", String(cfg.overrideStorageMb));
	if (cfg.forceBuild === true) args.push("--force-build");
	if (cfg.forceBuild === false) args.push("--no-force-build");
	if (cfg.deleteEnvironment === true) args.push("--delete");
	if (cfg.deleteEnvironment === false) args.push("--no-delete");
	if (cfg.yes) args.push("-y");

	if (cfg.agent === "omp") {
		args.push("--agent-import-path", AGENT_IMPORT_PATH);
	} else {
		args.push("--agent", cfg.agent);
	}
	args.push(...cfg.passthrough);
	return args;
}

const FORWARD_ENV_DENYLIST: Record<string, true> = {
	PI_CODING_AGENT_DIR: true,
	PI_CONFIG_DIR: true,
	PI_PROFILE: true,
	PI_PACKAGE_DIR: true,
	PI_SESSION_FILE: true,
	PI_ARTIFACTS_DIR: true,
	PI_TOOL_BRIDGE_URL: true,
	PI_TOOL_BRIDGE_TOKEN: true,
	PI_TOOL_BRIDGE_SESSION: true,
	PI_EVAL_LOCAL_ROOTS: true,
};

/**
 * Env vars injected into the in-container omp run: every host `PI_*` knob (minus
 * container-hostile dir/profile/session keys), a baseline native-addon default
 * for emulated linux/amd64 DeepSWE images, plus explicit `--env` entries,
 * which always win and bypass the denylist.
 */
export function collectForwardEnv(cfg: Config): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || !key.startsWith("PI_") || FORWARD_ENV_DENYLIST[key]) continue;
		out[key] = value;
	}
	if (!out.PI_NATIVE_VARIANT) out.PI_NATIVE_VARIANT = "baseline";
	for (const [key, value] of Object.entries(cfg.env)) out[key] = value;
	return out;
}

export function buildPierEnv(
	cfg: Config,
	modelsYaml: string,
	tarball: string | null,
	version: string,
): Record<string, string> {
	const env: Record<string, string> = { ...(process.env as Record<string, string>) };
	delete env.OMP_DEEPSWE_FORWARD_ENV;
	if (cfg.agent !== "omp") return env;
	const prepend = (key: string, value: string): void => {
		env[key] = env[key] ? `${value}:${env[key]}` : value;
	};
	prepend("PYTHONPATH", AGENT_DIR);
	env.OMP_DEEPSWE_INSTALL = cfg.install;
	env.OMP_DEEPSWE_VERSION = cfg.version ?? version;
	if (tarball) env.OMP_DEEPSWE_TARBALL = tarball;
	if (cfg.binaryArm64) env.OMP_DEEPSWE_BINARY_ARM64 = cfg.binaryArm64;
	if (cfg.binaryX64) env.OMP_DEEPSWE_BINARY_X64 = cfg.binaryX64;
	if (cfg.thinking) env.OMP_DEEPSWE_THINKING = cfg.thinking;
	env.OMP_DEEPSWE_AUTO_APPROVE = cfg.autoApprove ? "1" : "0";
	if (cfg.extraOmpArgs.length > 0) env.OMP_DEEPSWE_EXTRA_ARGS = cfg.extraOmpArgs.join(" ");
	if (cfg.advisorModel) {
		env.OMP_DEEPSWE_ADVISOR_MODEL = cfg.advisorModel;
		env.OMP_DEEPSWE_ADVISOR_SYNC = cfg.advisorSync;
	}
	if (cfg.webSearch) env.OMP_DEEPSWE_WEB_SEARCH = "1";
	env.OMP_DEEPSWE_GATEWAY = cfg.gateway ? "1" : "0";
	if (cfg.gateway) {
		env.OMP_DEEPSWE_MODELS_YAML = modelsYaml;
		env.OMP_DEEPSWE_GATEWAY_URL = cfg.gatewayUrl;
		env.OMP_DEEPSWE_GATEWAY_TOKEN = cfg.gatewayToken;
		env.OMP_DEEPSWE_GATEWAY_PROVIDERS = deriveProviders(cfg).join(",");
	}
	const forward = collectForwardEnv(cfg);
	if (Object.keys(forward).length > 0) env.OMP_DEEPSWE_FORWARD_ENV = JSON.stringify(forward);
	return env;
}

// ──────────────────────────────────────────────────────────────────────── main

function dryRunTarball(cfg: Config, benchRoot: string): string | null {
	if (cfg.agent !== "omp") return null;
	if (cfg.install === "binary" || cfg.install === "published") return null;
	if (cfg.tarball) return cfg.tarball;
	if (!cfg.build) return newestTarball(benchRoot) ?? "<no existing tarball found>";
	return "<local-pack-would-be-created>";
}

const SENSITIVE_VALUE_KEY = /TOKEN|KEY|SECRET|PASSWORD/i;

function redactConfigValue(key: string, value: string): string {
	return SENSITIVE_VALUE_KEY.test(key) ? "<redacted>" : value;
}

function printDryRun(
	cfg: Config,
	pierArgs: string[],
	modelsYaml: string,
	pierEnv: Record<string, string>,
	jobDir: string,
	benchDir: string,
): void {
	process.stdout.write(bold("\npier command:\n"));
	process.stdout.write(`pier ${pierArgs.join(" ")}\n\n`);
	if (cfg.gateway && cfg.agent === "omp") {
		process.stdout.write(bold("models.yml:\n"));
		process.stdout.write(`${modelsYaml}\n`);
	}
	process.stdout.write(bold("omp env:\n"));
	for (const key of Object.keys(pierEnv).sort()) {
		if (key === "OMP_DEEPSWE_FORWARD_ENV") continue;
		if (key.startsWith("OMP_DEEPSWE_") || key === "PYTHONPATH") {
			const value = redactConfigValue(key, pierEnv[key]);
			process.stdout.write(`  ${key}=${value}\n`);
		}
	}
	if (pierEnv.OMP_DEEPSWE_FORWARD_ENV) {
		const keys = Object.keys(JSON.parse(pierEnv.OMP_DEEPSWE_FORWARD_ENV) as Record<string, string>);
		process.stdout.write(`  OMP_DEEPSWE_FORWARD_ENV=${keys.join(",")} (values hidden)\n`);
	}
	process.stdout.write(`\njob dir: ${jobDir}\nbench dir: ${benchDir}\n`);
}

async function main(): Promise<void> {
	const cfg = parseArgs(process.argv.slice(2));
	if (!cfg) return;
	if (cfg.reportOnly) {
		runReportOnly(cfg);
		return;
	}
	ensureDirectAuthIsPossible(cfg);
	const taskInfo = validateTasksPath(cfg.tasksPath);
	preflightGatewayPort(cfg);
	preflightHostStorage(cfg);

	if (!cfg.dryRun && !which("pier")) {
		throw new Error("pier not found on PATH. Install with: uv tool install datacurve-pier");
	}
	if (!cfg.dryRun && cfg.agent === "omp" && !which("docker")) {
		throw new Error("docker not found on PATH (required to run task containers)");
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const modelSlug = cfg.models[0].replace(/[^a-zA-Z0-9]+/g, "-");
	const jobName = cfg.jobName ?? `deepswe-${modelSlug}-${stamp}`;
	const jobDir = path.join(cfg.jobsDir, jobName);
	const benchRoot = path.join(cfg.jobsDir, "_bench");
	const benchDir = path.join(benchRoot, jobName);
	const version = readPkgVersion();
	ensureJobDirAvailable(cfg, jobDir, benchDir);

	let tarball: string | null = cfg.tarball;
	if (cfg.agent === "omp" && cfg.install === "local") {
		if (cfg.dryRun) {
			tarball = dryRunTarball(cfg, benchRoot);
		} else if (tarball) {
			process.stdout.write(dim(`using tarball ${tarball}\n`));
		} else if (cfg.build) {
			tarball = buildTarball(benchRoot);
		} else {
			tarball = newestTarball(benchRoot);
			if (!tarball) throw new Error("--no-build but no tarball found; pass --tarball or drop --no-build");
		}
	}

	let modelsYamlPath = "";
	if (cfg.agent === "omp" && cfg.gateway) {
		modelsYamlPath = path.join(benchDir, "models.yml");
		if (!cfg.dryRun) {
			fs.mkdirSync(benchDir, { recursive: true });
			modelsYamlPath = writeModelsYaml(benchDir, cfg);
			if (!gatewayHealthOk(cfg.gatewayUrl)) {
				process.stderr.write(
					yellow(
						`warning: gateway ${cfg.gatewayUrl} health check failed (continuing). Is omp auth-gateway running?\n`,
					),
				);
			}
		}
	}

	const pierArgs = buildPierArgs(cfg, jobName);
	const pierEnv = buildPierEnv(cfg, modelsYamlPath, tarball, version);
	const logPath = path.join(benchDir, "pier.log");
	if (cfg.dryRun) {
		printDryRun(cfg, pierArgs, modelsYamlContent(cfg, true), pierEnv, jobDir, benchDir);
		return;
	}

	fs.mkdirSync(benchDir, { recursive: true });
	const expectedTasks = fallbackExpectedTasks(cfg, taskInfo);
	const expected = Math.max(1, expectedTasks * cfg.attempts * cfg.models.length);
	const startedAt = new Date().toISOString();
	const manifestPath = writeRunManifest(benchDir, jobName, jobDir, cfg, pierArgs, expected, startedAt);
	appendRunnerLog(benchDir, `manifest written ${manifestPath}`);
	process.stdout.write(dim(`DeepSWE tasks: ${taskInfo.count} found at ${taskInfo.path}\n`));
	process.stdout.write(dim(`launching pier → ${logPath}\n`));
	appendRunnerLog(benchDir, `spawning pier ${pierArgs.join(" ")}`);
	const logFd = fs.openSync(logPath, "a");
	const proc = Bun.spawn(["pier", ...pierArgs], {
		env: pierEnv,
		stdout: logFd,
		stderr: logFd,
		stdin: "ignore",
	});

	const st: RenderState = { cfg, jobDir, logPath, startMs: Date.now(), expected, tick: 0 };

	if (isTTY) process.stdout.write(`${ESC}?1049h${ESC}?25l`);
	let exitCode: number | null = null;
	let finished = false;
	let loopError: unknown = null;
	let interruptedSignal: "SIGINT" | "SIGTERM" | null = null;
	let forwardedSignal = false;
	let finalReportPath = path.join(benchDir, "report.md");
	proc.exited.then((code: number) => {
		exitCode = code;
		finished = true;
	});

	const handleSignal = (signal: "SIGINT" | "SIGTERM"): void => {
		if (!interruptedSignal) interruptedSignal = signal;
		appendRunnerLog(benchDir, `signal received ${signal}`);
		if (forwardedSignal) return;
		forwardedSignal = true;
		try {
			proc.kill(signal);
		} catch {
			/* ignore */
		}
	};
	const onSigint = (): void => handleSignal("SIGINT");
	const onSigterm = (): void => handleSignal("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);

	try {
		let nextReportAt = Date.now() + cfg.reportIntervalSec * 1000;
		while (!finished) {
			render(st);
			st.tick++;
			if (Date.now() >= nextReportAt) {
				try {
					writeReport(st, benchDir, "running", null);
				} catch (err) {
					appendRunnerLog(
						benchDir,
						`periodic report write failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				nextReportAt = Date.now() + cfg.reportIntervalSec * 1000;
			}
			await Bun.sleep(isTTY ? 700 : 10000);
		}
		render(st);
	} catch (err) {
		loopError = err;
	} finally {
		if (isTTY) process.stdout.write(`${ESC}?25h${ESC}?1049l`);
		try {
			fs.closeSync(logFd);
		} catch {
			/* ignore */
		}
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		const finalState: ReportState = loopError ? "error" : interruptedSignal ? "interrupted" : "complete";
		try {
			finalReportPath = writeReport(st, benchDir, finalState, exitCode);
			appendRunnerLog(benchDir, `final report written ${finalReportPath} status=${finalState}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(red(`\nerror writing final report: ${message}\n`));
			appendRunnerLog(benchDir, `final report write failed: ${message}`);
		}
	}

	const trials = readTrials(jobDir);
	const totals = aggregate(trials, readJobResult(jobDir), expected);
	const successPct = totals.done > 0 ? (totals.pass / totals.done) * 100 : 0;
	const title = loopError ? "DeepSWE error" : interruptedSignal ? "DeepSWE interrupted" : "DeepSWE complete";
	process.stdout.write("\n");
	process.stdout.write(
		`${bold(title)} — ${green(`${totals.pass}/${totals.done} passed (${successPct.toFixed(1)}%)`)}\n`,
	);
	process.stdout.write(
		`fail ${totals.fail} · error ${totals.error} · spend ${fmtUsd(totals.costUsd)} · elapsed ${fmtDur(Date.now() - st.startMs)}\n`,
	);
	process.stdout.write(
		`tokens: in ${fmtNum(totals.tokIn)}   out ${fmtNum(totals.tokOut)}   cache ${fmtNum(totals.tokCache)}\n`,
	);
	process.stdout.write(`${dim("report:")} ${finalReportPath}\n`);
	process.stdout.write(`${dim("manifest:")} ${manifestPath}\n`);
	process.stdout.write(`${dim("runner log:")} ${path.join(benchDir, "runner.log")}\n`);
	process.stdout.write(`${dim("pier log:")} ${logPath}\n`);
	process.stdout.write(`${dim("trials:")} ${jobDir}\n`);
	if (exitCode !== null && exitCode !== 0) process.stdout.write(yellow(`pier exited ${exitCode}; see pier.log\n`));
	if (loopError) throw loopError;
	process.exit(exitCode ?? 1);
}

if (import.meta.main) {
	main().catch((err: unknown) => {
		if (isTTY) process.stdout.write(`${ESC}?25h${ESC}?1049l`);
		process.stderr.write(red(`\nerror: ${err instanceof Error ? err.message : String(err)}\n`));
		process.exit(1);
	});
}
