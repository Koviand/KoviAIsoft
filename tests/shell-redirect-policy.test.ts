import { describe, expect, it } from "vitest";
import { assertShellCommandPolicy } from "../packages/core/src/tools/sandbox";

const roots = ["C:\\Users\\me\\project", "C:\\Models"];

describe("assertShellCommandPolicy redirects", () => {
  it("allows relative redirect", () => {
    expect(() => assertShellCommandPolicy("echo hi > out.txt", roots)).not.toThrow();
  });

  it("blocks absolute Out-File outside roots", () => {
    expect(() =>
      assertShellCommandPolicy(
        'Out-File -FilePath "C:\\Windows\\Temp\\x.txt" -InputObject hi',
        roots,
      ),
    ).toThrow(/разрешён/i);
  });

  it("blocks EncodedCommand", () => {
    expect(() =>
      assertShellCommandPolicy("powershell -EncodedCommand AABB", roots),
    ).toThrow(/EncodedCommand/i);
  });

  it("blocks curl -o to absolute outside", () => {
    expect(() =>
      assertShellCommandPolicy("curl https://x -o C:\\Windows\\Temp\\a.exe", roots),
    ).toThrow(/разрешён|Скачивание/i);
  });
});
