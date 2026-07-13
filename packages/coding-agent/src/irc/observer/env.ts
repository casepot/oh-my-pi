const ALLOWED_ENV = [
	"PATH",
	"HOME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LC_ALL",
	"TZ",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
] as const;

export function ircObserverWorkerEnv(): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key of ALLOWED_ENV) {
		const value = process.env[key];
		if (value !== undefined) result[key] = value;
	}
	return result;
}
