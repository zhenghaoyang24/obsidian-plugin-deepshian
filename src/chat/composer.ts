import { Notice, TAbstractFile, TFolder, TFile } from "obsidian";
import { t as tt } from "../i18n";
import { modeMeta } from "./types";
import { previewLine } from "./utils";
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
import type { BridgeStatus, ChatMode, CommandInfo, ModelInfo, ModelSelection, SkillInfo } from "../bridge/types";

export interface ChatComposerCallbacks {
  onSend(text: string, mode: ChatMode): void;
  onStopRequest(): void;
  /**
   * Whether the session on screen is mid-turn — then the send button acts as
   * Stop. Background sessions running elsewhere do not count (agent pool).
   */
  isActiveBusy(): boolean;
  /** Input changed (textarea resized already); lets the view re-evaluate send state. */
  onInputChanged(): void;
}

/** Vault top-level directories never offered as @ references. */
const REF_EXCLUDED_DIRS = new Set([".git", ".obsidian", ".trash", "node_modules"]);
/** File types the sidebar can surface in @ references (everything Obsidian
 * can natively display: notes, canvases, PDFs, images, audio and video). */
const REF_FILE_EXTS = new Set([
  "md",
  "canvas",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "bmp",
  "mp3",
  "wav",
  "ogg",
  "m4a",
  "mp4",
  "webm",
]);
/** Maximum candidates rendered in one @ panel. */
const REF_MAX_RESULTS = 50;

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

  // @ file-reference panel state
  private refPanelEl!: HTMLElement;
  private refSearchEl!: HTMLInputElement;
  private refListEl!: HTMLElement;
  /** Folders expanded in the tree (paths). */
  private refExpanded = new Set<string>();

  // `/` command / skill picker panel state
  private cmdPanelEl!: HTMLElement;
  private cmdListEl!: HTMLElement;
  private cmdEntries: CommandInfo[] = [];
  private skillEntries: SkillInfo[] = [];
  /** Cached descriptor lookup for the send-time `/cmd` routing decision. */
  private cmdIndex = new Map<string, CommandInfo>();
  /** Backoff: only one request per opening, refreshed when the answers come. */
  private cmdRequested = false;
  /** Row under keyboard navigation in the currently open panel. */
  private cmdSelIndex = -1;
  private cmdFiltered: { kind: "command" | "skill"; name: string }[] = [];

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

    // @ file-reference panel, anchored to the card's top edge so its width
    // always matches the input box.
    this.refPanelEl = card.createDiv({ cls: "dshc-refpanel", attr: { hidden: "" } });
    this.refSearchEl = this.refPanelEl.createEl("input", {
      cls: "dshc-refsearch",
      attr: {
        type: "text",
        placeholder: tt("搜索文件或文件夹…", "Search files or folders…"),
        spellcheck: "false",
      },
    });
    this.refSearchEl.addEventListener("input", () => {
      // Typing in the search box rewrites the @ token so both stay in sync.
      const tok = this.refToken();
      if (!tok) return;
      const v = this.inputEl.value;
      this.inputEl.value = v.slice(0, tok.start) + "@" + this.refSearchEl.value + v.slice(tok.caret);
      const caret = tok.start + 1 + this.refSearchEl.value.length;
      this.inputEl.setSelectionRange(caret, caret);
      this.renderRefList();
    });
    this.refListEl = this.refPanelEl.createDiv({ cls: "dshc-ref-list" });

    // `/` command / skill picker panel, same anchor as the @ panel (they are
    // mutually exclusive per caret position, so only one is visible at a time).
    this.cmdPanelEl = card.createDiv({ cls: "dshc-cmdpanel", attr: { hidden: "" } });
    this.cmdListEl = this.cmdPanelEl.createDiv({ cls: "dshc-cmd-list" });

    // Owns the scroll once the textarea passes --dsh-input-max-height, so the
    // textarea itself never shows a scrollbar (mirrors the dsh web composer).
    const inputScroll = card.createDiv({ cls: "dshc-inputscroll" });
    this.inputEl = inputScroll.createEl("textarea", {
      cls: "dsh-input",
      // placeholder goes through the attr channel so it is guaranteed to
      // reach the DOM even if a host helper drops the top-level option.
      attr: {
        placeholder: tt(
          "描述你的想法，输入 @ 引用文件，输入 / 查看命令与技能",
          "Describe what you want — type @ to reference files, or / for commands and skills",
        ),
      },
    });
    this.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
      if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing) {
        evt.preventDefault();
        if (this.cmdPanelOpen() && this.cmdFiltered.length > 0) {
          this.chooseCmdSelection();
          return;
        }
        this.closeCmdPanel();
        this.closeRefPanel();
        this.sendCurrentInput();
      } else if (evt.key === "Escape") {
        this.closeRefPanel();
        this.closeCmdPanel();
      } else if (this.cmdPanelOpen() && (evt.key === "ArrowDown" || evt.key === "ArrowUp")) {
        if (this.cmdFiltered.length > 0) {
          evt.preventDefault();
          const n = this.cmdFiltered.length;
          this.cmdSelIndex =
            ((this.cmdSelIndex < 0 ? (evt.key === "ArrowDown" ? -1 : 0) : this.cmdSelIndex + (evt.key === "ArrowDown" ? 1 : -1)) + n) % n;
          this.renderCmdSelection();
        }
      }
    });
    this.inputEl.addEventListener("input", () => {
      this.autosize();
      this.callbacks.onInputChanged();
      this.refreshRefPanel();
      this.refreshCmdPanel();
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
      // The button is Stop only while the conversation on screen is producing;
      // a background session running in the pool must not hijack it.
      if (this.callbacks.isActiveBusy()) {
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
      tt(
        "描述你的想法，输入 @ 引用文件，输入 / 查看命令与技能",
        "Describe what you want — type @ to reference files, or / for commands and skills",
      ),
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
    if (!this.refPanelEl.hasAttribute("hidden")) {
      if (!this.refPanelEl.contains(target) && !this.inputEl.contains(target)) {
        this.closeRefPanel();
      }
    }
    if (this.cmdPanelEl && !this.cmdPanelEl.hasAttribute("hidden")) {
      if (!this.cmdPanelEl.contains(target) && !this.inputEl.contains(target)) {
        this.closeCmdPanel();
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

  // -------------------------------------------------------- @ file reference
  /**
   * Locate the `@` mention under the caret, if any. Recognized only at the
   * start of input or after whitespace (so emails never trigger it), mirroring
   * dsh web's file-reference grammar. `@"...` allows spaces in the path.
   */
  private refToken(): { start: number; caret: number; query: string } | null {
    const v = this.inputEl.value;
    const caret = this.inputEl.selectionStart ?? v.length;
    const prefix = v.slice(0, caret);
    const quoted = prefix.match(/(?:^|\s)@"([^"]*)$/);
    if (quoted) {
      return { start: quoted.index! + quoted[0].indexOf("@"), caret, query: quoted[1] };
    }
    const bare = prefix.match(/(?:^|\s)@([^\s@"]*)$/);
    if (!bare) return null;
    return { start: bare.index! + bare[0].indexOf("@"), caret, query: bare[1] };
  }

  /** Open or update the reference panel to follow the current @ token. */
  private refreshRefPanel(): void {
    const tok = this.refToken();
    if (!tok) {
      this.closeRefPanel();
      return;
    }
    if (this.refPanelEl.hasAttribute("hidden")) {
      this.refPanelEl.removeAttribute("hidden");
    }
    this.refSearchEl.value = tok.query;
    this.renderRefList();
  }

  private closeRefPanel(): void {
    if (this.refPanelEl && !this.refPanelEl.hasAttribute("hidden")) {
      this.refPanelEl.setAttribute("hidden", "");
    }
    this.refExpanded.clear();
  }

  /** Direct children of `dir` (folders first, visibility-filtered). */
  private refChildren(dir: string): TAbstractFile[] {
    const all = this.plugin.app.vault.getAllLoadedFiles();
    const prefix = dir === "" ? "" : `${dir}/`;
    return all
      .filter((f) => {
        if (f.path === dir || !f.path.startsWith(prefix)) return false;
        if (f.path.slice(prefix.length).includes("/")) return false;
        if (dir === "" && REF_EXCLUDED_DIRS.has(f.path.split("/")[0])) return false;
        return this.refVisible(f);
      })
      .sort((a, b) => this.refRank(a) - this.refRank(b) || a.path.localeCompare(b.path));
  }

  /** Folders before files (dsh web ranks candidates the same way). */
  private refRank(f: TAbstractFile): number {
    return f instanceof TFolder ? 0 : 1;
  }

  /** Vault-top-level dirs never referenced: .git / .obsidian / .trash / node_modules. */
  private refExcluded(f: TAbstractFile): boolean {
    const top = f.path.split("/")[0];
    return REF_EXCLUDED_DIRS.has(top);
  }

  /** Files only when Obsidian can display their type; folders always. */
  private refVisible(f: TAbstractFile): boolean {
    if (f instanceof TFolder) return true;
    if (!(f instanceof TFile)) return false;
    return REF_FILE_EXTS.has(f.extension.toLowerCase());
  }

  private renderRefList(): void {
    this.refListEl.empty();
    const tok = this.refToken();
    const query = tok?.query ?? "";
    if (query !== "") {
      this.renderRefSearch(query);
      return;
    }
    const active = this.plugin.app.workspace.getActiveFile();
    if (active) {
      if (REF_FILE_EXTS.has(active.extension.toLowerCase())) {
        this.appendRefSection(tt("当前文件", "Current file"));
        this.appendRefItem(active.name, 0, null, () => this.insertReference(active.path));
      }
      // Vault root is also a TFolder with an empty name — skip it so the
      // "current folder" section never shows a blank row for root files.
      const parent = active.parent;
      if (parent && !parent.isRoot()) {
        this.appendRefSection(tt("当前文件夹", "Current folder"));
        this.appendRefItem(parent.name, 0, parent.path, () =>
          this.insertReference(`${parent.path}/`),
        );
        if (this.refExpanded.has(parent.path)) {
          this.renderRefTree(parent.path, 1);
        }
      }
    }
    this.appendRefSection(tt("所有文件", "All files"));
    this.renderRefTree("", 0);
  }

  /** One small secondary-color section heading inside the panel. */
  private appendRefSection(title: string): void {
    this.refListEl.createDiv({ cls: "dshc-ref-section", text: title });
  }

  /**
   * One row: optional expand arrow (when `arrowTarget` is a folder path),
   * then the name. Only the arrow toggles the folder and only the name
   * selects — clicking the row's dead space does nothing.
   */
  private appendRefItem(
    name: string,
    depth: number,
    arrowTarget: string | null,
    onSelect: () => void,
  ): HTMLButtonElement {
    const row = this.refListEl.createEl("button", {
      cls: "dshc-ref-item",
      attr: { type: "button" },
    });
    row.style.paddingLeft = `${10 + depth * 16}px`;
    if (arrowTarget !== null) {
      const arrow = row.createSpan({ cls: "dshc-ref-arrow" });
      arrow.setText("▶");
      arrow.toggleClass("open", this.refExpanded.has(arrowTarget));
      arrow.addEventListener("click", () => this.toggleRefDir(arrowTarget));
    }
    const nameEl = row.createSpan({ cls: "dshc-ref-name", text: name });
    nameEl.addEventListener("click", () => onSelect());
    return row;
  }

  /** Tree mode: root children, then every expanded folder's children, lazily. */
  private renderRefTree(dir: string, depth: number): void {
    for (const f of this.refChildren(dir)) {
      const isDir = f instanceof TFolder;
      const name = f.path.split("/").pop() ?? f.path;
      this.appendRefItem(name, depth, isDir ? f.path : null, () => {
        if (isDir) this.insertReference(`${f.path}/`);
        else this.insertReference(f.path);
      });
      if (isDir && this.refExpanded.has(f.path)) {
        this.renderRefTree(f.path, depth + 1);
      }
    }
  }

  /** Expand/collapse one folder and repaint only that subtree's rows. */
  private toggleRefDir(path: string): void {
    const list = this.refListEl;
    // renderRefList() rebuilds the list (empty() clamps scrollTop to 0), so
    // restore the viewport position afterwards — expanding must never jump
    // the list back to the top.
    const scrollTop = list.scrollTop;
    if (this.refExpanded.has(path)) this.refExpanded.delete(path);
    else this.refExpanded.add(path);
    this.renderRefList();
    list.scrollTop = scrollTop;
  }

  /** Search mode: flat vault-wide matches; folders switch to tree browsing. */
  private renderRefSearch(query: string): void {
    const q = query.toLowerCase();
    const all = this.plugin.app.vault.getAllLoadedFiles();
    const matches = all
      .filter(
        (f) => !this.refExcluded(f) && this.refVisible(f) && f.path.toLowerCase().includes(q),
      )
      .sort((a, b) => this.refRank(a) - this.refRank(b) || a.path.localeCompare(b.path))
      .slice(0, REF_MAX_RESULTS);
    if (matches.length === 0) {
      this.refListEl.createDiv({
        cls: "dshc-ref-empty",
        text: tt("无匹配的文件或文件夹", "No matching files or folders"),
      });
      return;
    }
    for (const f of matches) {
      const isDir = f instanceof TFolder;
      const name = f.path.split("/").pop() ?? f.path;
      this.appendRefItem(name, 0, isDir ? f.path : null, () => {
        if (isDir) this.enterRefDir(f.path);
        else this.insertReference(f.path);
      });
    }
  }

  /** A folder picked from search: rewrite the @ token to "<dir>/" and expand it. */
  private enterRefDir(dir: string): void {
    const tok = this.refToken();
    if (!tok) return;
    const v = this.inputEl.value;
    this.inputEl.value = v.slice(0, tok.start) + `@${dir}/` + v.slice(tok.caret);
    const caret = tok.start + 1 + dir.length + 1;
    this.inputEl.setSelectionRange(caret, caret);
    this.refSearchEl.value = "";
    this.refExpanded.add(dir);
    this.renderRefList();
  }

  /** Insert the `@path` mention (quoted when it contains spaces) and close. */
  private insertReference(path: string): void {
    const tok = this.refToken();
    if (!tok) return;
    const mention = `@${/\s/.test(path) ? `"${path}"` : path} `;
    const v = this.inputEl.value;
    this.inputEl.value = v.slice(0, tok.start) + mention + v.slice(tok.caret);
    const caret = tok.start + mention.length;
    this.inputEl.setSelectionRange(caret, caret);
    this.inputEl.focus();
    this.closeRefPanel();
    this.autosize();
    this.callbacks.onInputChanged();
  }

  // --------------------------------------------------- `/` command picker
  /**
   * Adopt the command registry payload. Any open panel is re-rendered live so
   * a slow bridge answer never shows a stale one-command list.
   */
  applyCommands(commands: CommandInfo[], unsupported: boolean): void {
    this.cmdEntries = unsupported ? [] : commands;
    this.cmdIndex = new Map(this.cmdEntries.map((c) => [c.name, c]));
    if (this.cmdPanelOpen()) this.renderCmdList();
  }

  /** Adopt the skill catalog payload (same live-refresh rule as commands). */
  applySkills(skills: SkillInfo[], unsupported: boolean): void {
    this.skillEntries = unsupported ? [] : skills;
    if (this.cmdPanelOpen()) this.renderCmdList();
  }

  /**
   * Resolve one `/name` token against the known command registry. `null` when
   * the head word is unknown — the view then routes the line to the model
   * (which is how dsh treats skill gestures and unregistered phrases).
   */
  findCommand(name: string): CommandInfo | null {
    return this.cmdIndex.get(name) ?? null;
  }

  /** Locate the `/` token under the caret, if any (same grammar as @). An
   * empty query is a valid picker trigger: bare `/` opens the full list. */
  private cmdToken(): { start: number; caret: number; query: string } | null {
    const v = this.inputEl.value;
    const caret = this.inputEl.selectionStart ?? v.length;
    const prefix = v.slice(0, caret);
    const bare = prefix.match(/(?:^|\s)\/([a-z0-9][^\s/]*)?$/i);
    if (!bare) return null;
    return { start: bare.index! + bare[0].indexOf("/"), caret, query: bare[1] ?? "" };
  }

  private cmdPanelOpen(): boolean {
    return !this.cmdPanelEl.hasAttribute("hidden");
  }

  private openCmdPanel(): void {
    if (!this.cmdRequested) {
      this.cmdRequested = true;
      void this.plugin.sendCommand({ cmd: "list_commands" });
      void this.plugin.sendCommand({ cmd: "list_skills" });
    }
    this.closeRefPanel();
    this.cmdPanelEl.removeAttribute("hidden");
    this.renderCmdList();
  }

  private closeCmdPanel(): void {
    if (this.cmdPanelEl && !this.cmdPanelEl.hasAttribute("hidden")) {
      this.cmdPanelEl.setAttribute("hidden", "");
    }
    // Re-arm the fetch so the next open pulls fresh registry / catalog state.
    this.cmdRequested = false;
    this.cmdSelIndex = -1;
    this.cmdFiltered = [];
  }

  /** Open/update the panel to follow the current `/` token. */
  private refreshCmdPanel(): void {
    const tok = this.cmdToken();
    if (!tok) {
      this.closeCmdPanel();
      return;
    }
    this.openCmdPanel();
  }

  /** One row: `/name` plus one-line description. */
  private appendCmdItem(kind: "command" | "skill", name: string, description: string): HTMLButtonElement {
    const row = this.cmdListEl.createEl("button", {
      cls: "dshc-cmd-item",
      attr: { type: "button", "data-kind": kind },
    });
    row.createSpan({ cls: "dshc-cmd-name mono", text: `/${name}` });
    row.createSpan({ cls: "dshc-cmd-desc", text: previewLine(description) });
    row.addEventListener("click", () => this.insertCmd(kind, name));
    return row;
  }

  /** Rebuild the panel rows for the current query; keep selection in range. */
  private renderCmdList(): void {
    this.cmdListEl.empty();
    const tok = this.cmdToken();
    const query = (tok?.query ?? "").toLowerCase();

    const commands = this.cmdEntries.filter((c) => c.name.startsWith(query) || c.name.includes(query));
    const skills = this.skillEntries.filter(
      (s) => s.userInvocable && (s.name.startsWith(query) || s.name.includes(query)),
    );

    this.cmdFiltered = [
      ...commands.map((c) => ({ kind: "command" as const, name: c.name })),
      ...skills.map((s) => ({ kind: "skill" as const, name: s.name })),
    ];

    if (this.cmdEntries.length === 0 && this.skillEntries.length === 0) {
      this.cmdListEl.createDiv({
        cls: "dshc-cmd-empty",
        text: tt("当前 dsh 不提供命令 / 技能", "No commands or skills available in this dsh"),
      });
      this.cmdSelIndex = -1;
      return;
    }
    if (commands.length > 0) {
      this.cmdListEl.createDiv({ cls: "dshc-cmd-section", text: tt("命令", "Commands") });
      for (const c of commands) this.appendCmdItem("command", c.name, c.description);
    }
    if (skills.length > 0) {
      this.cmdListEl.createDiv({ cls: "dshc-cmd-section", text: tt("技能", "Skills") });
      for (const s of skills) this.appendCmdItem("skill", s.name, s.description);
    }
    if (this.cmdFiltered.length === 0) {
      this.cmdListEl.createDiv({
        cls: "dshc-cmd-empty",
        text: tt("无匹配的命令或技能", "No matching commands or skills"),
      });
      this.cmdSelIndex = -1;
      return;
    }
    if (this.cmdSelIndex >= this.cmdFiltered.length) this.cmdSelIndex = -1;
    this.renderCmdSelection();
  }

  /** Repaint just the `.selected` highlight (keyboard navigation). */
  private renderCmdSelection(): void {
    const rows = Array.from(this.cmdListEl.querySelectorAll<HTMLButtonElement>(".dshc-cmd-item"));
    rows.forEach((row, i) => {
      row.toggleClass("selected", i === this.cmdSelIndex);
      row.setAttribute("aria-selected", i === this.cmdSelIndex ? "true" : "false");
    });
    const cur = this.cmdFiltered[this.cmdSelIndex];
    if (cur) {
      const row = rows.find((r) => r.getAttribute("data-kind") === cur.kind && r.textContent?.includes(`/${cur.name}`));
      row?.scrollIntoView({ block: "nearest" });
    }
  }

  /** Enter on a picked row: insert `/name ` and close (mirrors dsh web). */
  private chooseCmdSelection(): void {
    const picked = this.cmdFiltered[this.cmdSelIndex];
    if (!picked) return;
    this.insertCmd(picked.kind, picked.name);
  }

  private insertCmd(kind: "command" | "skill", name: string): void {
    const tok = this.cmdToken();
    if (!tok) return;
    const v = this.inputEl.value;
    this.inputEl.value = v.slice(0, tok.start) + `/${name} ` + v.slice(tok.caret);
    const caret = tok.start + name.length + 2;
    this.inputEl.setSelectionRange(caret, caret);
    this.inputEl.focus();
    this.closeCmdPanel();
    this.autosize();
    this.callbacks.onInputChanged();
  }
}