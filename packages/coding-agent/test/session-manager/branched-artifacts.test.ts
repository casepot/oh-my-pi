import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("SessionManager branched artifacts", () => {
	it("copies referenced artifacts into a persisted branch and reserves their IDs", async () => {
		using tempDir = TempDir.createSync("@pi-session-branch-artifacts-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		try {
			const originalArtifactContent = "original artifact payload\nwith stable bytes";
			const originalArtifactId = await session.saveArtifact(originalArtifactContent, "bash");
			if (originalArtifactId !== "0")
				throw new Error(`expected first artifact id to be 0, got ${originalArtifactId}`);

			const branchPointId = session.appendMessage({
				role: "user",
				content: `Please inspect artifact://${originalArtifactId}`,
				timestamp: 1,
			});
			await session.ensureOnDisk();

			const sourceSessionFile = session.getSessionFile();
			if (!sourceSessionFile) throw new Error("expected persisted source session file");

			const branchSessionFile = session.createBranchedSession(branchPointId);
			expect(branchSessionFile).toBeString();
			expect(branchSessionFile).not.toBe(sourceSessionFile);

			const copiedArtifactPath = await session.getArtifactPath(originalArtifactId);
			expect(copiedArtifactPath).toBeString();
			if (!copiedArtifactPath) throw new Error("expected branched artifact path");
			expect(await Bun.file(copiedArtifactPath).text()).toBe(originalArtifactContent);

			const branchArtifactId = await session.saveArtifact("branch-only artifact", "bash");
			expect(branchArtifactId).toBe("1");
		} finally {
			await session.close();
		}
	});
});
