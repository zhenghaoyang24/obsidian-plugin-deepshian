import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";

type Selection = { provider: string; model: string };
const official = { provider: "deepseek-account", model: "deepseek-flash" };
const goat = { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash-fast" };

/** Exercise the shipped JSONL command handler and prompt path together.
 * The Agent fixture keeps its recorded route until model.select is called,
 * matching Harness 0.2's session-owned AgentModel contract. */
async function boot(saveBarrier = Promise.resolve(), savedSelections = new Map<string, Selection>()) {
  const source = readFileSync(new URL("../dsh-profile/deepshian/deepshian-bridge.mjs", import.meta.url), "utf8");
  const code = transformSync(source, { format: "cjs", target: "es2020" }).code;
  const events: Record<string, unknown>[] = [];
  const routes: Selection[] = [];
  const listeners = new Map<string, (raw: string) => void>();
  let defaultSelection = { ...official };
  function makeAgent(sessionId: string, fallback: Selection) {
    let current = { ...(savedSelections.get(sessionId) ?? fallback) };
    return {
      agent: {
        status: "idle",
        session: { id: sessionId, requestHeader: () => ({ config: current }) },
        model: {
          current: () => ({ ...current }),
          select: vi.fn((s: Selection) => {
            current = { ...s };
            savedSelections.set(sessionId, { ...s });
          }),
        },
        followup: () => { routes.push({ ...current }); },
        whenIdle: async () => {},
      },
      dispose: vi.fn(),
    };
  }
  const services = {
    agentDefaultModel: {
      currentSelection: () => ({ ...defaultSelection }),
      saveSelection: vi.fn(async (s: Selection) => { await saveBarrier; defaultSelection = { ...s }; }),
    },
    agents: {
      create: vi.fn(async (options: { sessionId: string; agentOptions: Selection; setup: (ctx: object) => void }) => {
        options.setup({ on: vi.fn(() => () => {}) });
        return makeAgent(options.sessionId, options.agentOptions);
      }),
      resume: vi.fn(async (options: { resumeSessionId: string; agentOptions: Selection; setup: (ctx: object) => void }) => {
        expect(savedSelections.has(options.resumeSessionId)).toBe(true);
        options.setup({ on: vi.fn(() => () => {}) });
        return makeAgent(options.resumeSessionId, options.agentOptions);
      }),
    },
    sessions: {},
  };
  const ctx = {
    get: (name: keyof typeof services) => services[name],
    on: vi.fn(() => () => {}),
  };
  const module = { exports: {} as { run: (ctx: object) => Promise<void> } };
  const require = createRequire(import.meta.url);
  runInNewContext(code + "\nmodule.exports.run = run;", {
    module, exports: module.exports,
    require: (id: string) => {
      if (id === "node:readline") return { createInterface: () => ({ on: (name: string, f: (raw: string) => void) => listeners.set(name, f) }) };
      if (id === "@deepseek-ai/dsh-agent") return { installModelSelection: vi.fn() };
      if (id === "@deepseek-ai/dsh-llm") return { createUserMessage: (m: object) => m };
      if (id === "@deepseek-ai/dsh-session") return { SessionId: (id: string) => id };
      if (id.startsWith("@deepseek-ai/")) return { setSandboxMode: vi.fn(), setApprovalPolicy: vi.fn() };
      return require(id);
    },
    process: { env: {}, cwd: () => "/test-vault", stdin: {}, stdout: { write: (line: string) => events.push(JSON.parse(line) as Record<string, unknown>) } },
    console,
  });
  await module.exports.run(ctx);
  const send = async (message: object) => {
    listeners.get("line")!(JSON.stringify(message));
    await setImmediate();
    expect(events.filter((e) => e.t === "error")).toEqual([]);
  };
  return { send, events, routes, savedSelections, services };
}

describe("switching providers in an existing conversation", () => {
  it("routes the next prompt through the selected provider without replacing the conversation", async () => {
    const bridge = await boot();
    await bridge.send({ prompt: "first", mode: "readonly" });
    await bridge.send({ cmd: "set_model", ...goat });
    await bridge.send({ prompt: "second", mode: "readonly" });
    expect(bridge.routes).toEqual([official, goat]);
    expect(bridge.services.agents.create).toHaveBeenCalledTimes(1);
    expect(bridge.events.filter((e) => e.t === "models").at(-1)?.current).toEqual(goat);
    expect(bridge.services.agentDefaultModel.saveSelection).not.toHaveBeenCalled();
  });

  it("restores the conversation's route in history and the menu without changing another chat", async () => {
    const bridge = await boot();
    await bridge.send({ prompt: "first", mode: "readonly" });
    const firstId = bridge.events.find((e) => e.t === "session_created")!.id;
    await bridge.send({ cmd: "set_model", ...goat });
    await bridge.send({ cmd: "new_chat" });
    await bridge.send({ prompt: "other chat", mode: "readonly" });
    await bridge.send({ cmd: "open_session", id: firstId });
    expect(bridge.events.filter((e) => e.t === "session_opened").at(-1)?.model).toBe(`${goat.provider}/${goat.model}`);
    await bridge.send({ cmd: "list_models" });
    expect(bridge.events.filter((e) => e.t === "models").at(-1)?.current).toEqual(goat);
    await bridge.send({ prompt: "same conversation again", mode: "readonly" });
    expect(bridge.routes).toEqual([official, official, goat]);
    expect(bridge.services.agents.create).toHaveBeenCalledTimes(2);
  });

  it("waits for a blank chat's saved selection before an immediately submitted prompt", async () => {
    let finishSave!: () => void;
    const barrier = new Promise<void>((resolve) => { finishSave = resolve; });
    const bridge = await boot(barrier);
    await bridge.send({ cmd: "set_model", ...goat });
    await bridge.send({ prompt: "immediate send", mode: "readonly" });
    expect(bridge.routes).toEqual([]);
    finishSave();
    await bridge.send({ cmd: "list_models" });
    expect(bridge.routes).toEqual([goat]);
  });

  it("resumes a persisted selection after a restart instead of substituting the deployment default", async () => {
    const first = await boot();
    await first.send({ prompt: "first", mode: "readonly" });
    const id = first.events.find((e) => e.t === "session_created")!.id;
    await first.send({ cmd: "set_model", ...goat });

    const restarted = await boot(Promise.resolve(), first.savedSelections);
    await restarted.send({ cmd: "open_session", id });
    expect(restarted.events.filter((e) => e.t === "session_opened").at(-1)?.model).toBe(`${goat.provider}/${goat.model}`);
    await restarted.send({ cmd: "list_models" });
    expect(restarted.events.filter((e) => e.t === "models").at(-1)?.current).toEqual(goat);
    await restarted.send({ prompt: "continue", mode: "readonly" });
    expect(restarted.routes).toEqual([goat]);
    expect(restarted.services.agents.create).not.toHaveBeenCalled();
    expect(restarted.services.agents.resume).toHaveBeenCalledTimes(1);
  });

  it("applies rapid saved selections in order before sending the first prompt", async () => {
    let finishSave!: () => void;
    const barrier = new Promise<void>((resolve) => { finishSave = resolve; });
    const bridge = await boot(barrier);
    await bridge.send({ cmd: "set_model", ...goat });
    await bridge.send({ cmd: "set_model", ...official });
    await bridge.send({ prompt: "send after both switches", mode: "readonly" });
    expect(bridge.routes).toEqual([]);
    finishSave();
    await bridge.send({ cmd: "list_models" });
    expect(bridge.routes).toEqual([official]);
    expect(bridge.services.agentDefaultModel.saveSelection.mock.calls.map(([s]) => s)).toEqual([goat, official]);
  });
});
