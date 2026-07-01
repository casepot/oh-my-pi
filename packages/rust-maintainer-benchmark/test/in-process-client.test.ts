import { describe, expect, it } from "bun:test";
import { createBenchmarkSettingsOverrides } from "@oh-my-pi/rust-maintainer-benchmark/in-process-client";

describe("createBenchmarkSettingsOverrides", () => {
	it("disables memory and autolearn by default", () => {
		expect(createBenchmarkSettingsOverrides()).toEqual({
			"memory.backend": "off",
			"memories.enabled": false,
			"autolearn.enabled": false,
		});
	});

	it("includes explicit edit options", () => {
		expect(
			createBenchmarkSettingsOverrides({
				editVariant: "apply_patch",
				editFuzzy: true,
				editFuzzyThreshold: 0.8,
			}),
		).toEqual({
			"memory.backend": "off",
			"memories.enabled": false,
			"autolearn.enabled": false,
			"edit.mode": "apply_patch",
			"edit.fuzzyMatch": true,
			"edit.fuzzyThreshold": 0.8,
		});
	});

	it("omits auto edit options", () => {
		expect(
			createBenchmarkSettingsOverrides({
				editVariant: "auto",
				editFuzzy: "auto",
				editFuzzyThreshold: "auto",
			}),
		).toEqual({
			"memory.backend": "off",
			"memories.enabled": false,
			"autolearn.enabled": false,
		});
	});
});
