import { buildSync } from "esbuild";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

interface ComposerState {
  plugin: { bridge: { model: string } };
  currentSelection: { provider: string; model: string } | null;
  modelsCache: { provider: string; id: string; name: string }[];
  modelBtnLabel: { setText(text: string): void };
  modelBtn: { setAttribute(name: string, value: string): void };
  renderModelFallback(): void;
}

function composer() {
  const output = buildSync({
    entryPoints: [fileURLToPath(new URL("../src/chat/composer.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "node",
    external: ["obsidian"],
  });
  const module = { exports: {} as { ChatComposer: { prototype: {
    renderModelFallback(this: ComposerState): void;
    setModelSelection(this: ComposerState, raw: string): void;
  } } } };
  runInNewContext(output.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: (id: string) => {
      if (id === "obsidian") return {};
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  const prototype = module.exports.ChatComposer.prototype;
  const setText = vi.fn();
  const setAttribute = vi.fn();
  const state: ComposerState = {
    plugin: { bridge: { model: "commandcode/deepseek/deepseek-v4.1-flash-fast" } },
    currentSelection: null,
    modelsCache: [],
    modelBtnLabel: { setText },
    modelBtn: { setAttribute },
    renderModelFallback() { prototype.renderModelFallback.call(this); },
  };
  return { prototype, state, setText, setAttribute };
}

describe("model name presentation", () => {
  it("keeps every segment of a model id before the catalog arrives", () => {
    const { state, setText } = composer();
    state.renderModelFallback();
    expect(setText).toHaveBeenLastCalledWith("deepseek/deepseek-v4.1-flash-fast");
  });

  it("keeps the catalog name and exposes its provider and full id on the trigger", () => {
    const { state, setText, setAttribute } = composer();
    const name = "DeepSeek V4.1 Flash Fast (latest)";
    state.modelsCache = [{ provider: "commandcode", id: "deepseek/deepseek-v4.1-flash-fast", name }];
    state.renderModelFallback();
    expect(setText).toHaveBeenLastCalledWith(name);
    expect(setAttribute).toHaveBeenCalledWith("title", `${name}\ncommandcode/deepseek/deepseek-v4.1-flash-fast`);
    expect(setAttribute).toHaveBeenCalledWith("aria-label", `${name} (commandcode)`);
  });

  it("uses a restored session's selection instead of the previous bridge model", () => {
    const { prototype, state, setText } = composer();
    state.plugin.bridge.model = "deepseek-account/deepseek-flash";
    state.modelsCache = [{ provider: "commandcode", id: "deepseek/deepseek-v4.1-flash-fast", name: "Full Fast model name" }];
    prototype.setModelSelection.call(state, "commandcode/deepseek/deepseek-v4.1-flash-fast");
    expect(setText).toHaveBeenLastCalledWith("Full Fast model name");
  });
});
