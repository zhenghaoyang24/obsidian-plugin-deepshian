import { describe, expect, it } from "vitest";
import { formatTime, parseModelString, previewLine, summarizeInput } from "../src/chat/utils";

describe("previewLine", () => {
  it("collapses whitespace and trims", () => {
    expect(previewLine("  a  b\n\t c  ")).toBe("a b c");
  });

  it("truncates to 64 chars with an ellipsis", () => {
    const long = "x".repeat(100);
    const out = previewLine(long);
    expect(out).toBe("x".repeat(63) + "…");
  });

  it("keeps short text untouched", () => {
    expect(previewLine("short")).toBe("short");
  });
});

describe("summarizeInput", () => {
  it("extracts known keys in priority order", () => {
    expect(summarizeInput({ command: "ls", file_path: "/x" })).toBe("ls");
    expect(summarizeInput({ file_path: "/x" })).toBe("/x");
    expect(summarizeInput({ path: "p", query: "q" })).toBe("p");
  });

  it("skips empty string values, falls back to JSON for whitespace-only", () => {
    expect(summarizeInput({ command: "  " })).toBe('{"command":" "}');
  });

  it("falls back to JSON for non-matching objects", () => {
    expect(summarizeInput({ a: 1 })).toBe('{"a":1}');
  });

  it("returns empty for non-objects", () => {
    expect(summarizeInput(null)).toBe("");
    expect(summarizeInput("text")).toBe("");
  });
});

describe("parseModelString", () => {
  it("splits provider/model", () => {
    expect(parseModelString("opencode-go/deepseek-v4-flash")).toEqual({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
    });
  });

  it("returns null without a slash or with a leading slash", () => {
    expect(parseModelString("model-only")).toBeNull();
    expect(parseModelString("/model")).toBeNull();
  });
});

describe("formatTime", () => {
  it("formats a timestamp as locale date/time", () => {
    const ms = new Date(2026, 7, 31, 14, 30).getTime();
    expect(formatTime(ms)).toMatch(/\d/);
  });

  it("never throws and returns a string on invalid input", () => {
    expect(typeof formatTime(Number.NaN)).toBe("string");
    expect(typeof formatTime(Number.POSITIVE_INFINITY)).toBe("string");
  });
});