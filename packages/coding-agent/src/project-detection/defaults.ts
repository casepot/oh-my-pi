import type { ProjectDetectorDefinition } from "./types";

export const DEFAULT_PROJECT_DETECTORS: readonly ProjectDetectorDefinition[] = [
	{
		id: "rust",
		rootMarkers: ["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "rustfmt.toml", "clippy.toml"],
		fileGlobs: ["**/*.rs"],
	},
	{
		id: "node",
		rootMarkers: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"],
	},
	{
		id: "typescript",
		rootMarkers: ["tsconfig.json", "tsconfig.base.json", "jsconfig.json"],
		fileGlobs: ["**/*.ts", "**/*.tsx"],
	},
	{
		id: "python",
		rootMarkers: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", "uv.lock"],
		fileGlobs: ["**/*.py"],
	},
	{
		id: "go",
		rootMarkers: ["go.mod", "go.sum"],
		fileGlobs: ["**/*.go"],
	},
	{
		id: "java",
		rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts"],
		fileGlobs: ["**/*.java", "**/*.kt"],
	},
];
