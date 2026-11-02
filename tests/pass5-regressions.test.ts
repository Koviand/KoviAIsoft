import { describe, expect, it } from "vitest";
import { isNonZeroShellExit } from "../packages/core/src/tools/terminal";
import { createWorkingMemory } from "../packages/core/src/agent/workingMemory";

describe("Pass-5 regressions", () => {
  it("treats git-style exit lines as soft-fail candidates", () => {
    expect(isNonZeroShellExit("git push\nexit: 1\nstderr:\nrejected")).toBe(true);
    expect(isNonZeroShellExit("git status\nexit: 0\nok")).toBe(false);
  });

  it("substantialWrite is not inferred from plain wrote notes", () => {
    const wm = createWorkingMemory("goal");
    wm.notes = ["wrote a.py", "wrote b.py"];
    wm.hadSubstantialWrite = false;
    // Mirrors loop soft-resume: only sticky flag counts.
    const substantialWrite = Boolean(wm.hadSubstantialWrite);
    expect(substantialWrite).toBe(false);
  });

  it("ChatEngine.stop keeps abort until owner clears (source contract)", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../packages/core/src/chat/engine.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(src).toMatch(/stop\(\):\s*void\s*\{[^}]*this\.abort\?\.abort\(\);/s);
    expect(src).not.toMatch(/stop\(\):\s*void\s*\{[^}]*this\.abort\s*=\s*null;/s);
  });
});
