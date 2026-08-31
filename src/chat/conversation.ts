import { App, Component, MarkdownRenderer, Notice } from "obsidian";
import { t as tt } from "../i18n";
import { copyLabel, RENDER_THROTTLE_MS, type AssistantEntry, type Entry, type ToolEntry, type UserEntry } from "./types";
import { copyText, previewLine, summarizeInput } from "./utils";
import {
  ICON_CHEVRON,
  ICON_COMMAND,
  ICON_COPY,
  ICON_THINK,
  svgIcon,
} from "./icons";
import type { ReplayTurn } from "../bridge/types";

/**
 * Owns the conversation column: assistant/user bubbles, streaming markdown,
 * the Think disclosure, tool cards, token usage, the per-turn clock, and the
 * copy actions. All DOM lives under `.dshc-scroll` / `.dshc-column`.
 */
export class ChatConversation {
  private entries: Entry[] = [];
  private currentAssistant: AssistantEntry | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private turnStartedAt = 0;

  private messagesEl!: HTMLElement;
  private columnEl!: HTMLElement;

  constructor(
    private app: App,
    private contentEl: HTMLElement,
    /** Render context for MarkdownRenderer (must stay alive with the view). */
    private component: Component,
  ) {}

  get current(): AssistantEntry | null {
    return this.currentAssistant;
  }

  build(): void {
    this.messagesEl = this.contentEl.createDiv({ cls: "dshc-scroll" });
    this.columnEl = this.messagesEl.createDiv({ cls: "dshc-column" });
  }

  /** Reset to the empty New Session state (DOM + streaming state). */
  clear(): void {
    this.entries = [];
    this.currentAssistant = null;
    this.stopClock();
    this.columnEl.empty();
  }

  /** Cancel timers; called from the view's onClose. */
  dispose(): void {
    if (this.renderTimer != null) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.stopClock();
  }

  // --------------------------------------------------------------- events
  /** Append the user message as a finished bubble; returns it for mutation. */
  appendUser(text: string): UserEntry {
    const entry: UserEntry = { kind: "user", text };
    this.entries.push(entry);
    this.appendUserBubble(entry);
    this.scrollBottom();
    return entry;
  }

  /** A new assistant turn started: build its card and start the clock. */
  pushAssistant(): AssistantEntry {
    const entry: AssistantEntry = {
      kind: "assistant",
      text: "",
      reasoning: "",
      tools: [],
    };
    const root = this.columnEl.createDiv({ cls: "dshc-item" });
    entry.rootEl = root;

    entry.statusEl = root.createDiv({ cls: "dshc-turnstatus" });
    entry.statusEl.createSpan({
      cls: "dshc-turnstatus-text",
      text: tt("正在思考…", "Thinking…"),
    });
    entry.clockEl = entry.statusEl.createSpan({
      cls: "dshc-turnstatus-clock",
      text: "0:00",
    });
    this.startClock(entry);

    entry.reasoningEl = root.createEl("details", {
      cls: "dshc-disc dshc-reasoning",
      attr: { style: "display:none", "data-state": "running" },
    });
    const rrow = entry.reasoningEl.createEl("summary", { cls: "dshc-discrow" });
    const rleading = rrow.createSpan({ cls: "dshc-leading" });
    rleading.createSpan({ cls: "dshc-ico" }).append(svgIcon(ICON_THINK));
    rleading.createSpan({ cls: "dshc-chev" }).append(svgIcon(ICON_CHEVRON));
    rrow.createSpan({ cls: "dshc-title", text: "Think" });
    rrow.createSpan({ cls: "dshc-sep" });
    entry.reasoningSumEl = rrow.createSpan({ cls: "dshc-sum" });
    entry.reasoningBodyEl = entry.reasoningEl.createDiv({ cls: "dshc-thinkbody" });

    entry.toolsEl = root.createDiv({ cls: "dshc-tools" });
    entry.textEl = root.createDiv({ cls: "dshc-md" });
    entry.errorEl = root.createDiv({ cls: "dshc-error" });
    // Message footer: copy action + token usage, left-aligned; stays hidden
    // (.is-pending) until the turn finishes, then revealed by finishAssistant.
    const foot = root.createDiv({ cls: "dshc-foot is-pending" });
    entry.footEl = foot;
    this.buildCopyButton(foot, () => {
      const text = entry.text.trim();
      return text !== "" ? text : (entry.error ?? "");
    }, copyLabel());
    entry.usageEl = foot.createDiv({ cls: "dshc-usage" });

    this.entries.push(entry);
    this.scrollBottom();
    return entry;
  }

  appendReasoning(delta: string): void {
    const cur = this.currentAssistant;
    if (!cur) return;
    cur.reasoning += delta;
    this.renderReasoning(cur);
  }

  appendText(delta: string): void {
    const cur = this.currentAssistant;
    if (!cur) return;
    cur.text += delta;
    this.scheduleRender(cur);
  }

  addTool(callId: string | undefined, name: string, input: unknown): void {
    const cur = this.currentAssistant ?? this.pushAssistant();
    const details = this.buildToolCard(cur.toolsEl ?? this.columnEl, name, input);
    cur.tools.push({
      callId: callId ?? `tool-${this.entries.length}`,
      name,
      input,
      done: false,
      detailsEl: details,
      stateEl: details.querySelector<HTMLElement>(".dshc-dot") ?? undefined,
      summaryEl: details.querySelector<HTMLElement>(".dshc-sum") ?? undefined,
      outputEl: details.querySelector<HTMLPreElement>(".dshc-output") ?? undefined,
    });
    this.scrollBottom();
  }

  fillTool(tool: ToolEntry, output: string, isError: boolean): void {
    tool.output = output;
    tool.isError = isError;
    tool.done = true;
    const state = isError ? "error" : "ok";
    tool.detailsEl?.setAttribute("data-state", state);
    tool.stateEl?.setAttribute("data-state", state);
    tool.summaryEl?.setText(
      isError ? tt("失败", "failed") : output ? previewLine(output) : tt("完成", "done"),
    );
    if (tool.outputEl && output) {
      tool.outputEl.removeAttribute("style");
      tool.outputEl.textContent = output;
    }
    this.scrollBottom();
  }

  setUsage(usage: Record<string, number>): void {
    const cur = this.currentAssistant;
    if (cur) {
      cur.usage = usage;
      this.renderUsage(cur);
    }
  }

  /** The turn finished (normal, error, or interrupted): finalize the card. */
  finishTurn(reason: string, error?: string): void {
    const cur = this.currentAssistant;
    if (cur) {
      if (reason === "error" || error) cur.error = error ?? reason;
      this.flushMarkdown(cur);
      this.renderUsage(cur);
      this.renderError(cur);
      this.finishAssistant(cur);
    }
    this.currentAssistant = null;
  }

  /**
   * The dsh process died (or a new chat restarted the bridge) while a turn was
   * streaming: finalize the open entry so its clock stops, tool cards leave
   * the running state, and the send button unlocks for the next attempt.
   */
  abandonTurn(): void {
    const cur = this.currentAssistant;
    if (!cur) return;
    for (const tool of cur.tools) {
      if (tool.done) continue;
      tool.done = true;
      tool.detailsEl?.setAttribute("data-state", "error");
      tool.stateEl?.setAttribute("data-state", "error");
      tool.summaryEl?.setText(tt("已停止", "stopped"));
    }
    cur.error ??= tt("回合被中断（dsh 已停止）", "turn interrupted (dsh stopped)");
    this.renderError(cur);
    this.finishAssistant(cur);
    this.currentAssistant = null;
  }

  /** Render a restored session's folded turns into finished cards. */
  renderReplay(turns: ReplayTurn[]): void {
    this.columnEl.empty();
    this.entries = [];
    for (const turn of turns) {
      if (turn.user && turn.user.trim() !== "") {
        this.appendUserBubble({ kind: "user", text: turn.user });
      }
      if (
        (turn.assistant && turn.assistant.trim() !== "") ||
        (turn.tools != null && turn.tools.length > 0)
      ) {
        const entry = this.pushAssistant();
        this.finishAssistant(entry); // no shimmer / clock for replayed turns
        entry.text = turn.assistant ?? "";
        if (entry.text.trim() !== "") this.flushMarkdown(entry);
        for (const tool of turn.tools ?? []) {
          const details = this.buildToolCard(entry.toolsEl ?? this.columnEl, tool.name, tool.input);
          details.setAttribute("data-state", tool.isError ? "error" : "ok");
          details.querySelector(".dshc-dot")?.setAttribute("data-state", tool.isError ? "error" : "ok");
          details.querySelector<HTMLElement>(".dshc-sum")?.setText(
            tool.isError
              ? tt("失败", "failed")
              : tool.output
                ? previewLine(tool.output)
                : tt("完成", "done"),
          );
          const pre = details.querySelector<HTMLPreElement>(".dshc-output");
          if (pre && tool.output) {
            pre.removeAttribute("style");
            pre.textContent = tool.output;
          }
        }
        if (turn.usage && Object.keys(turn.usage).length > 0) {
          entry.usage = turn.usage;
          this.renderUsage(entry);
        }
      }
    }
    this.scrollBottom();
  }

  pushSystemNote(message: string): void {
    const note = this.columnEl.createDiv({ cls: "dsh-system" });
    note.setText(message);
    this.scrollBottom();
  }

  // ------------------------------------------------------------- rendering
  private startClock(entry: AssistantEntry): void {
    this.turnStartedAt = Date.now();
    this.stopClock();
    this.clockTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - this.turnStartedAt) / 1000);
      entry.clockEl?.setText(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`);
    }, 1000);
  }

  private stopClock(): void {
    if (this.clockTimer != null) {
      clearInterval(this.clockTimer);
      this.clockTimer = null;
    }
  }

  private finishAssistant(entry: AssistantEntry): void {
    this.stopClock();
    entry.footEl?.removeClass("is-pending");
    entry.statusEl?.remove();
    entry.statusEl = undefined;
    entry.clockEl = undefined;
    entry.reasoningEl?.setAttribute("data-state", "ok");
    if (entry.reasoningSumEl) {
      const firstLine = entry.reasoning.slice(0, Math.max(0, entry.reasoning.indexOf("\n")));
      entry.reasoningSumEl.setText(previewLine(firstLine));
    }
  }

  private scheduleRender(entry: AssistantEntry): void {
    if (this.renderTimer != null) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.flushMarkdown(entry);
      this.scrollBottom();
    }, RENDER_THROTTLE_MS);
  }

  /** Re-render one assistant bubble's markdown into a fresh container. */
  private flushMarkdown(entry: AssistantEntry): void {
    if (!entry.rootEl || !entry.textEl) return;
    if (entry.text.length === 0) return;
    const frag = createDiv();
    void MarkdownRenderer.render(this.app, entry.text, frag, "", this.component);
    entry.textEl.replaceChildren(...Array.from(frag.childNodes));
  }

  private renderReasoning(entry: AssistantEntry): void {
    const el = entry.reasoningEl;
    const body = entry.reasoningBodyEl;
    const sum = entry.reasoningSumEl;
    if (!el || !body || !sum) return;
    if (entry.reasoning.length > 0) el.removeAttribute("style");
    body.textContent = entry.reasoning;
    // dsh shows the latest line as the collapsed summary while streaming.
    const visible = entry.reasoning.trimEnd();
    const nl = visible.lastIndexOf("\n");
    sum.setText(nl === -1 ? visible : visible.slice(nl + 1));
    this.scrollBottom();
  }

  /** Build one dsh-style disclosure-row tool card inside `container`. */
  private buildToolCard(
    container: HTMLElement,
    name: string,
    input: unknown,
  ): HTMLDetailsElement {
    const details = container.createEl("details", {
      cls: "dshc-disc dshc-tool",
      attr: { "data-state": "running" },
    });
    const row = details.createEl("summary", { cls: "dshc-discrow" });
    const leading = row.createSpan({ cls: "dshc-leading" });
    leading.createSpan({ cls: "dshc-ico" }).append(svgIcon(ICON_COMMAND));
    leading.createSpan({ cls: "dshc-chev" }).append(svgIcon(ICON_CHEVRON));
    row.createSpan({ cls: "dshc-dot" });
    row.createSpan({ cls: "dshc-title mono", text: name });
    row.createSpan({ cls: "dshc-sep" });
    row.createSpan({ cls: "dshc-sum", text: summarizeInput(input) });
    const body = details.createDiv({ cls: "dshc-toolbody" });
    if (input != null && Object.keys(input as object).length > 0) {
      body.createEl("pre", {
        cls: "dshc-pre",
        text: JSON.stringify(input, null, 2),
      });
    }
    body.createEl("pre", {
      cls: "dshc-pre dshc-output",
      attr: { style: "display:none" },
    });
    return details;
  }

  private renderUsage(entry: AssistantEntry): void {
    if (!entry.usageEl || !entry.usage) return;
    const u = entry.usage;
    const parts: string[] = [];
    if (u.inputTokens != null) parts.push(`in ${u.inputTokens}`);
    if (u.outputTokens != null) parts.push(`out ${u.outputTokens}`);
    if (u.cacheReadTokens != null) parts.push(`cache ${u.cacheReadTokens}`);
    entry.usageEl.setText(parts.join(" · "));
  }

  private renderError(entry: AssistantEntry): void {
    if (!entry.errorEl || !entry.error) return;
    entry.errorEl.empty();
    entry.errorEl.createSpan({ cls: "dshc-error-dot" });
    entry.errorEl.createSpan({ cls: "dshc-error-msg", text: entry.error });
  }

  private appendUserBubble(entry: UserEntry): void {
    const row = this.columnEl.createDiv({ cls: "dshc-userrow" });
    const bubble = row.createDiv({ cls: "dshc-bubble" });
    bubble.setText(entry.text);
    this.buildCopyButton(row, () => entry.text, copyLabel());
    this.scrollBottom();
  }

  // ------------------------------------------------------------ clipboard
  /** Ghost copy button (optional label; flashes "Copied" on success). */
  private buildCopyButton(
    container: HTMLElement,
    getText: () => string,
    label?: string,
  ): HTMLButtonElement {
    const btn = container.createEl("button", {
      cls: "dshc-copybtn",
      attr: {
        type: "button",
        "aria-label": label ?? tt("复制消息", "Copy message"),
        title: label ?? tt("复制消息", "Copy message"),
      },
    });
    btn.createSpan({ cls: "dshc-copy-icon" }).append(svgIcon(ICON_COPY));
    if (label !== undefined) {
      btn.createSpan({ cls: "dshc-copy-label", text: copyLabel() });
    }
    btn.addEventListener("click", () => {
      void this.handleCopy(btn, getText());
    });
    return btn;
  }

  private async handleCopy(btn: HTMLButtonElement, text: string): Promise<void> {
    // Ignore re-clicks while the success flash is still showing.
    if (btn.hasClass("copied") || !text) return;
    const ok = await copyText(text);
    if (!ok) {
      new Notice(tt("复制失败", "Copy failed"));
      return;
    }
    const label = btn.querySelector<HTMLElement>(".dshc-copy-label");
    btn.addClass("copied");
    if (label) label.setText(tt("已复制", "Copied"));
    window.setTimeout(() => {
      btn.removeClass("copied");
      if (label) label.setText(copyLabel());
    }, 1500);
  }

  scrollBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}