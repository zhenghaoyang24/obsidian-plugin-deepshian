import { describe, expect, it, vi } from "vitest";
import { DshBridge } from "../src/bridge/bridge";

function makeBridge() {
  const onEvent = vi.fn();
  const onStatus = vi.fn();
  const bridge = new DshBridge({ onEvent, onStatus });
  const handleLine = (
    bridge as unknown as { handleLine(raw: string): void }
  ).handleLine.bind(bridge);
  return { onEvent, onStatus, handleLine };
}

describe("DshBridge.handleLine", () => {
  it("ignores empty and non-JSON lines", () => {
    const { onEvent, onStatus, handleLine } = makeBridge();
    handleLine("");
    handleLine("  ");
    handleLine("not json");
    expect(onEvent).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("adopts ready: status ready with the model, forwards the event", () => {
    const { onEvent, onStatus, handleLine } = makeBridge();
    handleLine(JSON.stringify({ t: "ready", model: "opencode-go/deepseek-v4-flash", cwd: "/vault" }));
    expect(onStatus).toHaveBeenCalledWith("ready", "opencode-go/deepseek-v4-flash");
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ t: "ready" }));
  });

  it("tracks turn_start -> running and turn_end -> ready", () => {
    const { onStatus, handleLine } = makeBridge();
    handleLine(JSON.stringify({ t: "ready", model: "m" }));
    onStatus.mockClear();
    handleLine(JSON.stringify({ t: "turn_start" }));
    expect(onStatus).toHaveBeenCalledWith("running");
    onStatus.mockClear();
    handleLine(JSON.stringify({ t: "turn_end", reason: "completed" }));
    expect(onStatus).toHaveBeenCalledWith("ready", "m");
  });

  it("stays running while any pooled session still has an open turn", () => {
    const { onStatus, handleLine } = makeBridge();
    handleLine(JSON.stringify({ t: "ready", model: "m" }));
    onStatus.mockClear();
    handleLine(JSON.stringify({ t: "turn_start", session: "a" }));
    handleLine(JSON.stringify({ t: "turn_start", session: "b" }));
    // Session a settles; b is still streaming, so the pool stays running.
    handleLine(JSON.stringify({ t: "turn_end", session: "a", reason: "completed" }));
    expect(onStatus).not.toHaveBeenCalledWith("ready", expect.anything());
    handleLine(JSON.stringify({ t: "turn_end", session: "b", reason: "completed" }));
    expect(onStatus).toHaveBeenCalledWith("ready", "m");
  });

  it("does not flip status back to ready when not running", () => {
    const { onEvent, onStatus, handleLine } = makeBridge();
    handleLine(JSON.stringify({ t: "turn_end", reason: "completed" }));
    expect(onStatus).not.toHaveBeenCalledWith("ready", expect.anything());
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ t: "turn_end" }));
  });

  it("forwards stream events unchanged", () => {
    const { onEvent, handleLine } = makeBridge();
    handleLine(JSON.stringify({ t: "text", delta: "hello" }));
    expect(onEvent).toHaveBeenCalledWith({ t: "text", delta: "hello" });
    handleLine(JSON.stringify({ t: "tool_use", name: "bash", input: { command: "ls" } }));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ t: "tool_use", name: "bash" }));
  });
});