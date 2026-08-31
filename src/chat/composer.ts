import { Notice } from "obsidian";
import { t as tt } from "../i18n";
import { modeMeta } from "./types";
import { parseModelString } from "./utils";
import {
  ICON_CHECK,
  ICON_CHEVRON,
  ICON_MODE_READONLY,
  ICON_MODE_WRITE,
  ICON_SEND,
  ICON_SPARKLE,
  ICON_STOP,
  svgIcon,
} from "./icons";
import type DshBridgePlugin from "../main";
import type { BridgeStatus, ChatMode, ModelInfo, ModelSelection } from "../bridge/types";

export interface ChatComposerCallbacks {
  onSend(text: string, mode: ChatMode): void;
  onStopRequest(): void;
  /** Whether an assistant turn is streaming — the send button acts as Stop. */
  isStreaming(): boolean;
  /** Input changed (textarea resized already); lets the view re-evaluate send state. */
  onInputChanged(): void;
}

/**
 * Owns the composer card: the autosizing textarea, the access-mode select, the
 * model selector menu, and the round send/stop button.
 */
export class ChatComposer {
  mode: ChatMode;

  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private modeTriggerBtn!: HTMLButtonElement;
  private modeTriggerIcon!: HTMLElement;
  private modeTriggerLabel!: HTMLElement;
  private modeMenuEl!: HTMLElement;
  private modelWrapEl!: HTMLElement;
  private modelBtn!: HTMLButtonElement;
  private modelBtnLabel!: HTMLElement;
  private modelMenuEl!: HTMLElement;

  private modelsCache: ModelInfo[] = [];
  private currentSelection: ModelSelection | null = null;

  constructor(
    private contentEl: HTMLElement,
    private plugin: DshBridgePlugin,
    private callbacks: ChatComposerCallbacks,
  ) {
    this.mode = plugin.settings.readonlyByDefault ? "readonly" : "writable";
  }

  build(): void {
    const composer = this.contentEl.createDiv({ cls: "dsh-composer" });
    const card = composer.createDiv({ cls: "dshc-card" });

    // Owns the scroll once the textarea passes --dsh-input-max-height, so the
    // textarea itself never shows a scrollbar (mirrors the dsh web composer).
    const inputScroll = card.createDiv({ cls: "dshc-inputscroll" });
    this.inputEl = inputScroll.createEl("textarea", {
      cls: "dsh-input",
      // placeholder goes through the attr channel so it is guaranteed to
      // reach the DOM even if a host helper drops the top-level option.
      attr: {
        placeholder: tt(
          "向 DeepShian 描述你想完成的事情…",
          "Describe what you want DeepShian to accomplish…",
        ),
      },
    });
    this.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing) {
        evt.preventDefault();
        this.sendCurrentInput();
      }
    });
    this.inputEl.addEventListener("input", () => {
      this.autosize();
      this.callbacks.onInputChanged();
    });

    const row = card.createDiv({ cls: "dshc-row" });

    // Access-mode select, bottom-left of the composer card (dsh web style).
    const modewrap = row.createDiv({ cls: "dshc-modewrap" });
    this.modeTriggerBtn = modewrap.createEl("button", { cls: "dshc-mode-trigger" });
    this.modeTriggerIcon = this.modeTriggerBtn.createSpan({ cls: "dshc-trigger-icon" });
    this.modeTriggerLabel = this.modeTriggerBtn.createSpan({ cls: "dshc-trigger-label" });
    this.modeTriggerBtn
      .createSpan({ cls: "dshc-trigger-chevron" })
      .append(svgIcon(ICON_CHEVRON));
    this.modeMenuEl = modewrap.createDiv({ cls: "dshc-menu", attr: { hidden: "" } });
    for (const value of ["readonly", "writable"] as ChatMode[]) {
      const item = this.modeMenuEl.createEl("button", {
        cls: "dshc-menu-item",
        attr: { type: "button", role: "option", "data-value": value },
      });
      item.createSpan({ cls: "dshc-item-icon" }).append(
        svgIcon(value === "readonly" ? ICON_MODE_READONLY : ICON_MODE_WRITE),
      );
      item.createSpan({ cls: "dshc-item-label", text: modeMeta(value).label });
      item.createSpan({ cls: "dshc-item-check" }).append(svgIcon(ICON_CHECK));
      item.addEventListener("click", () => {
        if (this.mode !== value) {
          this.mode = value;
          this.applyMode();
        }
        this.closeModeMenu();
      });
    }
    this.modeTriggerBtn.addEventListener("click", () => {
      if (this.modeMenuEl.hasAttribute("hidden")) this.openModeMenu();
      else this.closeModeMenu();
    });
    this.applyMode();

    // Model selector, immediately left of the send button (dsh web style).
    this.modelWrapEl = row.createDiv({ cls: "dshc-modewrap dshc-modelwrap" });
    this.modelBtn = this.modelWrapEl.createEl("button", { cls: "dshc-mode-trigger" });
    this.modelBtn.createSpan({ cls: "dshc-trigger-icon" }).append(svgIcon(ICON_SPARKLE));
    this.modelBtnLabel = this.modelBtn.createSpan({ cls: "dshc-trigger-label" });
    this.modelBtn.createSpan({ cls: "dshc-trigger-chevron" }).append(svgIcon(ICON_CHEVRON));
    this.modelMenuEl = this.modelWrapEl.createDiv({ cls: "dshc-menu", attr: { hidden: "" } });
    this.modelBtn.addEventListener("click", () => {
      if (this.plugin.bridgeStatus() === "stopped") {
        new Notice(tt("DSH 未运行", "DSH is not running"));
        return;
      }
      if (this.modelMenuEl.hasAttribute("hidden")) {
        // Refresh the catalog every open; applyModels repaints live if stale.
        void this.plugin.sendCommand({ cmd: "list_models" });
        this.openModelMenu();
      } else {
        this.closeModelMenu();
      }
    });
    this.renderModelFallback();

    row.createDiv({ cls: "dshc-rowspacer" });

    // Primary round button; the icon flips to the stop glyph while running.
    this.sendBtn = row.createEl("button", { cls: "dshc-send", attr: { type: "button" } });
    this.sendBtn.createSpan({ cls: "dshc-send-icon" }).append(svgIcon(ICON_SEND));
    this.sendBtn.createSpan({ cls: "dshc-stop-icon" }).append(svgIcon(ICON_STOP));
    this.sendBtn.addEventListener("click", () => {
      const running = this.plugin.bridgeStatus() === "running" || this.callbacks.isStreaming();
      if (running) {
        this.callbacks.onStopRequest();
      } else {
        this.sendCurrentInput();
      }
    });
  }

  /** Raw trimmed input text (the view sends it via onSend). */
  inputText(): string {
    return this.inputEl.value.trim();
  }

  clearInput(): void {
    this.inputEl.value = "";
    this.autosize();
  }

  /** Re-paint locale-dependent labels after a language switch. */
  relocalize(): void {
    this.inputEl.setAttribute(
      "placeholder",
      tt("向 DeepShian 描述你想完成的事情…", "Describe what you want DeepShian to accomplish…"),
    );
    for (const item of Array.from(this.modeMenuEl.children) as HTMLElement[]) {
      const value = item.getAttribute("data-value") as ChatMode | null;
      if (!value) continue;
      item.querySelector<HTMLElement>(".dshc-item-label")?.setText(modeMeta(value).label);
    }
    this.applyMode();
  }

  /** Send button state + model selector availability. */
  renderStatus(status: BridgeStatus, running: boolean): void {
    const connecting = status === "connecting";
    // While a turn runs the button stays enabled and acts as a red Stop; only
    // the pre-boot "connecting" state locks it out.
    // Disabled while connecting and whenever there is nothing to send —
    // except while a turn runs, where the button acts as Stop.
    const inputEmpty = this.inputEl ? this.inputEl.value.trim() === "" : true;
    this.sendBtn.disabled = connecting || (!running && inputEmpty);
    this.sendBtn.toggleClass("is-running", running);
    this.sendBtn.setAttribute(
      "aria-label",
      running
        ? tt("停止生成", "Stop generating")
        : tt("发送消息", "Send message"),
    );
    this.sendBtn.setAttribute(
      "title",
      running
        ? tt("点击停止当前生成", "Click to stop the current generation")
        : tt("发送消息", "Send message"),
    );

    const alive = status !== "stopped" && status !== "connecting";
    this.modelBtn.disabled = !alive;
  }

  /** Rebuild the model menu from the latest ModelsEvent payload. */
  applyModels(models: ModelInfo[], current: ModelSelection): void {
    this.modelsCache = models;
    this.currentSelection = current;
    if (!this.currentSelection) return;
    const { provider, model } = this.currentSelection;
    const exact = this.modelsCache.find((m) => m.provider === provider && m.id === model);
    this.modelBtnLabel.setText(exact?.name ?? model);

    this.modelMenuEl.empty();
    if (this.modelsCache.length === 0) {
      // Catalog request still in flight; keep the menu informative meanwhile.
      this.modelMenuEl.createDiv({
        cls: "dshc-menu-empty",
        text: tt("模型目录加载中…", "Loading model catalog…"),
      });
      return;
    }
    const multiProvider =
      new Set(this.modelsCache.map((m) => m.provider)).size > 1;
    for (const m of this.modelsCache) {
      const item = this.modelMenuEl.createEl("button", {
        cls: "dshc-menu-item",
        attr: {
          type: "button",
          role: "option",
          "data-provider": m.provider,
          "data-model": m.id,
        },
      });
      const textCol = item.createDiv({ cls: "dshc-model-text" });
      textCol.createDiv({ cls: "dshc-model-name", text: m.name });
      if (multiProvider) {
        textCol.createDiv({ cls: "dshc-model-provider", text: m.provider });
      }
      item.createSpan({ cls: "dshc-item-check" }).append(svgIcon(ICON_CHECK));
      const selected = m.provider === provider && m.id === model;
      item.toggleClass("selected", selected);
      item.setAttribute("aria-selected", selected ? "true" : "false");
      item.addEventListener("click", () => {
        if (!selected) {
          void this.plugin.sendCommand({
            cmd: "set_model",
            provider: m.provider,
            model: m.id,
          });
          // optimistic until the authoritative ModelsEvent round-trips
          this.modelBtnLabel.setText(m.name);
        }
        this.closeModelMenu();
      });
    }
  }

  /** Adopt the selection announced by a session_opened payload. */
  setModelSelection(raw: string): void {
    this.currentSelection = parseModelString(raw);
    this.renderModelFallback();
  }

  /** Fallback pill label before the first ModelsEvent arrives. */
  renderModelFallback(): void {
    const raw = this.plugin.bridge.model;
    const model = raw.includes("/") ? (raw.split("/")[1] ?? raw) : raw || "…";
    this.modelBtnLabel.setText(model);
  }

  /** Close the mode/model menus when a pointerdown lands outside them. */
  handleDocPointerDown(target: Node | null): void {
    if (!this.modeMenuEl.hasAttribute("hidden")) {
      const wrap = this.modeMenuEl.parentElement;
      if (!(wrap && wrap.contains(target))) this.closeModeMenu();
    }
    if (!this.modelMenuEl.hasAttribute("hidden")) {
      const wrap = this.modelMenuEl.parentElement;
      if (!(wrap && wrap.contains(target)) && !this.modelBtn.contains(target)) {
        this.closeModelMenu();
      }
    }
  }

  // ---------------------------------------------------------------- private
  /** The textarea owns no scrollbar: always grows to fit its content. */
  private autosize(): void {
    const ta = this.inputEl;
    // No CSS `height` rule on .dsh-input, so removing the inline height is
    // exactly `height: auto` — the collapsed state the measure needs.
    ta.style.removeProperty("height");
    ta.style.height = `${ta.scrollHeight}px`;
  }

  private sendCurrentInput(): void {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.callbacks.onSend(text, this.mode);
  }

  /** Reflect the active mode into trigger label/icon/menu selection state. */
  private applyMode(): void {
    const meta = modeMeta(this.mode);
    this.modeTriggerLabel.setText(meta.label);
    this.modeTriggerIcon.replaceChildren(
      svgIcon(this.mode === "readonly" ? ICON_MODE_READONLY : ICON_MODE_WRITE),
    );
    this.modeTriggerBtn.setAttribute(
      "aria-label",
      `${tt("访问模式，当前：", "Access mode, current: ")}${meta.label}`,
    );
    this.modeTriggerBtn.setAttribute("title", meta.title);
    for (const item of Array.from(this.modeMenuEl.children) as HTMLElement[]) {
      const selected = item.getAttribute("data-value") === this.mode;
      item.toggleClass("selected", selected);
      item.setAttribute("aria-selected", selected ? "true" : "false");
    }
  }

  private openModeMenu(): void {
    this.modeMenuEl.removeAttribute("hidden");
    this.modeTriggerBtn.addClass("open");
  }
  private closeModeMenu(): void {
    this.modeMenuEl.setAttribute("hidden", "");
    this.modeTriggerBtn.removeClass("open");
  }
  private openModelMenu(): void {
    this.modelMenuEl.removeAttribute("hidden");
    this.modelBtn.addClass("open");
  }
  private closeModelMenu(): void {
    this.modelMenuEl.setAttribute("hidden", "");
    this.modelBtn.removeClass("open");
  }
}