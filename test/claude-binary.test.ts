import { describe, expect, it } from "vitest";
import { enhancedPath, locateClaude } from "../src/desktop/claude-binary";

const files = (...paths: string[]) => (p: string) => paths.includes(p);

describe("locateClaude", () => {
  it("prefers the native Windows installer", () => {
    expect(
      locateClaude({
        platform: "win32",
        home: "C:\\Users\\me",
        env: { PATH: "C:\\Users\\me\\AppData\\Roaming\\npm" },
        isFile: files("C:\\Users\\me\\.local\\bin\\claude.exe", "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.exe"),
      }),
    ).toBe("C:\\Users\\me\\.local\\bin\\claude.exe");
  });

  it("never picks npm .cmd shims on Windows; falls back to cli.js", () => {
    expect(
      locateClaude({
        platform: "win32",
        home: "C:\\Users\\me",
        env: { PATH: "C:\\npm", APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
        isFile: files("C:\\npm\\claude.cmd", "C:\\npm\\claude", "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"),
      }),
    ).toBe("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js");
  });

  it("finds ~/.local/bin/claude, then Homebrew, then PATH on Unix", () => {
    const base = { platform: "darwin" as const, home: "/Users/me", env: { PATH: "/custom" } };
    expect(locateClaude({ ...base, isFile: files("/Users/me/.local/bin/claude", "/opt/homebrew/bin/claude") })).toBe(
      "/Users/me/.local/bin/claude",
    );
    expect(locateClaude({ ...base, isFile: files("/opt/homebrew/bin/claude") })).toBe("/opt/homebrew/bin/claude");
    expect(locateClaude({ ...base, isFile: files("/custom/claude") })).toBe("/custom/claude");
    expect(locateClaude({ ...base, isFile: files() })).toBeNull();
  });
});

describe("enhancedPath", () => {
  it("adds common bin dirs without duplicates", () => {
    const out = enhancedPath({ platform: "darwin", home: "/Users/me", env: { PATH: "/usr/bin:/bin" } }, "/Users/me/.local/bin/claude");
    expect(out.split(":")).toEqual(["/usr/bin", "/bin", "/Users/me/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
  });
});
