import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";

type Event = { type: string; data?: Record<string, unknown> };
type Wire = { t: string; session?: string; delta?: string };
type Frame = { type: string; chunk?: Record<string, unknown> };
type Agent = { session: { id: string } };
type Listener = (payload: { agent: Agent; frame: Frame }) => void;
interface Hooks {
  mapEvent(event: Event, sid: string): void;
  foldHistory(events: Event[]): { user: string; assistant: string }[];
  sessionEvents(session: object): Event[];
  installStreamTap(ctx: { on: (name: string, listener: Listener) => () => void }, handles: Map<string, object>): () => void;
}

/** Execute the entire shipped module, including its real text extractor.
 * SDK imports are inert: these tests never boot an agent or access a vault. */
function loadBridge() {
  const source = readFileSync(new URL("../dsh-profile/deepshian/deepshian-bridge.mjs", import.meta.url), "utf8");
  const code = transformSync(source, { format: "cjs", target: "es2020" }).code;
  const events: Wire[] = [];
  const module = { exports: {} as { hooks: Hooks } };
  const require = createRequire(import.meta.url);
  runInNewContext(code + `
    module.exports.hooks = {
      mapEvent, foldHistory,
      sessionEvents: typeof sessionEvents === "function" ? sessionEvents : undefined,
      installStreamTap: typeof installStreamTap === "function" ? installStreamTap : undefined,
    };`, {
    module,
    exports: module.exports,
    require: (id: string) => id.startsWith("@deepseek-ai/") ? {} : require(id),
    process: { env: {}, stdout: { write: (line: string) => events.push(JSON.parse(line) as Wire) } },
  });
  return { ...module.exports.hooks, events };
}

const message = (text: string) => ({ type: "assistant/message", data: { message: {
  content: [{ type: "reasoning", text: "private reasoning fixture" }, { type: "text", text }],
} } });
const chunk = (text: string) => ({ type: "assistant/chunk", data: { chunk: { type: "text-delta", text } } });
const answer = (events: Wire[], session = "a") => events.filter((e) => e.t === "text" && e.session === session).map((e) => e.delta).join("");

describe("Harness output compatibility", () => {
  it("forwards a completed answer without exposing reasoning-only tool steps", () => {
    const bridge = loadBridge();
    bridge.mapEvent(message(""), "a");
    expect(answer(bridge.events)).toBe("");
    bridge.mapEvent({ type: "step/start" }, "a");
    bridge.mapEvent(message("PING_OK"), "a");
    expect(answer(bridge.events)).toBe("PING_OK");
  });

  it("does not duplicate streamed text when the completed message arrives", () => {
    const bridge = loadBridge();
    bridge.mapEvent(chunk("PING"), "a");
    bridge.mapEvent(chunk("_OK"), "a");
    bridge.mapEvent(message("PING_OK"), "a");
    expect(answer(bridge.events)).toBe("PING_OK");
  });

  it("recovers a missing stream suffix and resets between assistant steps", () => {
    const bridge = loadBridge();
    bridge.mapEvent(chunk("P"), "a");
    bridge.mapEvent(message("PING_OK"), "a");
    bridge.mapEvent({ type: "step/start" }, "a");
    bridge.mapEvent(message("NEXT"), "a");
    expect(answer(bridge.events)).toBe("PING_OKNEXT");
  });

  it("keeps output from concurrent sessions separate", () => {
    const bridge = loadBridge();
    bridge.mapEvent(chunk("A"), "a");
    bridge.mapEvent(message("B"), "b");
    bridge.mapEvent(message("A"), "a");
    expect(answer(bridge.events, "a")).toBe("A");
    expect(answer(bridge.events, "b")).toBe("B");
  });

  it("routes new live frames only for sessions owned by this bridge", () => {
    const bridge = loadBridge();
    let listener: Listener | undefined;
    const dispose = vi.fn();
    const on = vi.fn((_name: string, callback: Listener) => { listener = callback; return dispose; });
    const cleanup = bridge.installStreamTap({ on }, new Map([["a", {}]]));
    expect(on).toHaveBeenCalledWith("agent/assistant-stream", expect.any(Function));
    const send = (id: string, frame: Frame) => listener!({ agent: { session: { id } }, frame });
    send("other", { type: "chunk", chunk: { type: "text-delta", text: "foreign" } });
    send("a", { type: "start" });
    send("a", { type: "chunk", chunk: { type: "reasoning-delta", text: "thinking" } });
    send("a", { type: "chunk", chunk: { type: "text-delta", text: "PING_OK" } });
    send("a", { type: "end" });
    expect(answer(bridge.events)).toBe("PING_OK");
    expect(bridge.events.filter((e) => e.t === "reasoning")).toEqual([{ t: "reasoning", session: "a", delta: "thinking" }]);
    cleanup();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("replays text from current snapshots and legacy event arrays without reasoning", () => {
    const bridge = loadBridge();
    const events = [{ type: "turn/start" }, {
      type: "user/message", data: { source: { kind: "user" }, content: [{ type: "text", text: "hello" }] },
    }, message("answer"), { type: "turn/end" }];
    const snapshotEvents = vi.fn(() => events);
    for (const session of [{ snapshotEvents }, { events }]) {
      const turns = bridge.foldHistory(bridge.sessionEvents(session));
      expect(turns).toHaveLength(1);
      expect(turns[0].user).toBe("hello");
      expect(turns[0].assistant).toBe("answer");
    }
    expect(snapshotEvents).toHaveBeenCalledOnce();
  });
});
