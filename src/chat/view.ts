import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
// `tt(zh, en)` resolves against the live locale (i18n module), so strings
// rendered after a language switch come out in the new language immediately.
import { t as tt } from "../i18n";
import { ChatConversation } from "./conversation";
import { ChatComposer } from "./composer";
import { ChatHeader } from "./header";
import type DshBridgePlugin from "../main";
import type { BridgeStatus, ChatMode, DshEvent, SessionSummary } from "../bridge/types";

export const VIEW_TYPE_DSH_CHAT = "dsh-chat-view";

/**
 * The sidebar chat view, mirroring the dsh web conversation UI: streaming
 * markdown, a Think disclosure row with sweep animation, tool disclosure rows,
 * token stats, a rounded composer card whose textarea grows without its own
 * scrollbar, a dsh-style access-mode select at the card's bottom-left, and a
 * circular send button that stays disabled until the current turn finishes.
 *
 * Owns the bridge-facing session state (active session, title, sessions
 * cache, auto-resume) and delegates the three DOM regions to ChatHeader,
 * ChatConversation and ChatComposer.
 */
export class DshChatView extends ItemView {
  private header!: ChatHeader;
  private conversation!: ChatConversation;
  private composer!: ChatComposer;

  // session sync state
  private sessionsCache: SessionSummary[] = [];
  private activeSessionId = "";
  /** Current session title, resolved by id against the latest sessions payload. */
  private currentSessionTitle = "";
  private sessionsRefreshTimer: number | null = null;
  /** Low-frequency poll so deletions/archives made in dsh web drop out of the list. */
  private sessionsSyncTimer: number | null = null;
  /** Set when the boot auto-resume is armed; consumed by the next sessions payload. */
  private pendingResume = false;
  /** Suppress one boot auto-resume because the user explicitly asked for a new chat. */
  private skipNextResume = false;

  private bannerEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: DshBridgePlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_DSH_CHAT;
  }
  getDisplayText(): string {
    return tt("DSH 对话", "DSH chat");
  }
  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("dsh-chat");

    this.header = new ChatHeader(this.contentEl, this.plugin, {
      onNewChat: () => this.startNewChat(),
      onOpenSession: (id) => void this.plugin.sendCommand({ cmd: "open_session", id }),
      isBusy: () => this.isBusy(),
    });
    this.header.build();

    this.conversation = new ChatConversation(this.app, this.contentEl, this);
    this.conversation.build();

    this.composer = new ChatComposer(this.contentEl, this.plugin, {
      onSend: (text, mode) => this.sendCurrentInput(text, mode),
      onStopRequest: () => {
        void this.plugin.sendCommand({ cmd: "stop" });
        new Notice(tt("已请求停止生成", "Stop requested"));
      },
      isStreaming: () => this.conversation.current !== null,
      onInputChanged: () => this.renderStatus(),
    });
    this.composer.build();

    this.bannerEl = this.contentEl.createDiv({
      cls: "dsh-banner is-hidden",
      text: "",
    });
    document.addEventListener("pointerdown", this.onDocPointerDown);
    this.plugin.bindView(this);
    this.plugin.ensureBridge();
    this.renderStatus();
    // Keep the history list in step with dsh web: re-query every 12s so a
    // session deleted/archived there disappears here without a manual refresh.
    this.sessionsSyncTimer = window.setInterval(() => {
      if (this.plugin.bridgeStatus() !== "stopped") {
        void this.plugin.sendCommand({ cmd: "list_sessions" });
      }
    }, 12000);
  }

  async onClose(): Promise<void> {
    if (this.sessionsRefreshTimer != null) window.clearTimeout(this.sessionsRefreshTimer);
    if (this.sessionsSyncTimer != null) window.clearInterval(this.sessionsSyncTimer);
    this.conversation.dispose();
    document.removeEventListener("pointerdown", this.onDocPointerDown);
    this.plugin.unbindView(this);
  }

  /**
   * Re-paint locale-dependent chrome after a language switch (settings tab →
   * plugin.onLanguageChanged). Never touches conversation entries, so it is
   * safe mid-turn; already-rendered messages keep their original language and
   * anything rendered afterwards uses the new one.
   */
  relocalize(): void {
    if (!this.header) return; // view not built yet; onOpen will localize
    this.header.relocalize();
    this.composer.relocalize();
    this.renderHeaderTitle();
    this.header.renderSessions(this.activeSessionId);
    this.renderStatus();
  }

  // ------------------------------------------------------------- external
  handleStatus(status: BridgeStatus, info?: string): void {
    if (status === "stopped") {
      this.conversation.abandonTurn();
    }
    if (status === "stopped" && info) {
      this.showBanner(info);
    } else if (status === "ready") {
      this.hideBanner();
      this.composer.renderModelFallback();
    }
    this.renderStatus();
  }

  handleEvent(event: DshEvent): void {
    switch (event.t) {
      case "turn_start":
        this.conversation.pushAssistant();
        this.renderStatus();
        break;
      case "reasoning":
        this.conversation.appendReasoning(event.delta);
        break;
      case "text":
        this.conversation.appendText(event.delta);
        break;
      case "tool_use":
        this.conversation.addTool(event.callId, event.name ?? "(unknown)", event.input);
        break;
      case "tool_result": {
        const cur = this.conversation.current;
        const callId = event.callId ?? "";
        let tool =
          callId && cur ? cur.tools.find((x) => x.callId === callId && !x.done) : undefined;
        if (!tool && cur) tool = cur.tools.find((x) => !x.done);
        if (tool) this.conversation.fillTool(tool, event.output ?? "", event.isError === true);
        break;
      }
      case "usage":
        this.conversation.setUsage(event.usage);
        break;
      case "turn_end":
        this.conversation.finishTurn(event.reason, event.error);
        this.renderStatus();
        this.conversation.scrollBottom();
        // Session titles are generated once turns complete — refresh lazily.
        this.scheduleSessionsRefresh(1500);
        break;
      case "error":
        new Notice(`DSH: ${event.message}`);
        this.conversation.pushSystemNote(event.message);
        break;
      case "ready":
        this.activeSessionId = event.session ?? "";
        this.currentSessionTitle = "";
        this.composer.renderModelFallback();
        this.renderHeaderTitle();
        // Pull persisted titles (incl. the fresh one) shortly after boot.
        this.scheduleSessionsRefresh(1200);
        // Per the "On open" setting, auto-resume the most recent conversation
        // for this vault once. An explicit "new chat" request suppresses it.
        if (this.skipNextResume) {
          this.skipNextResume = false;
        } else if (this.plugin.settings.onOpen === "resume") {
          this.pendingResume = true;
          void this.plugin.sendCommand({ cmd: "list_sessions" });
        }
        break;
      case "models":
        this.composer.applyModels(event.models, event.current);
        break;
      case "sessions": {
        const archivedId = event.archived ?? "";
        this.sessionsCache = event.sessions;
        this.header.setSessions(event.sessions);
        this.refreshCurrentTitle();
        this.header.renderSessions(this.activeSessionId);
        if (archivedId) {
          if (archivedId === this.activeSessionId) {
            // dsh web parity: archiving the current selection clears it to
            // New Session; the bridge has already dropped that live agent.
            this.clearConversation(false);
            this.header.closeHistory();
          }
          new Notice(tt("会话已归档", "Session archived"));
        }
        if (this.pendingResume) {
          this.pendingResume = false;
          this.resumeNewest(event.sessions);
        }
        break;
      }
      case "session_created":
        // A fresh session was minted on the first message of a new chat —
        // adopt it so its generated title lands in the header.
        this.activeSessionId = event.id;
        this.currentSessionTitle = "";
        this.renderHeaderTitle();
        this.scheduleSessionsRefresh(1200);
        break;
      case "session_opened": {
        const opened = event.id === this.activeSessionId;
        this.activeSessionId = event.id;
        this.composer.setModelSelection(event.model);
        this.refreshCurrentTitle();
        this.scheduleSessionsRefresh(500);
        this.header.closeHistory();
        this.header.clearPendingRows();
        this.conversation.renderReplay(event.turns);
        if (!opened) {
          new Notice(
            tt("已打开历史会话（上下文完整恢复）", "Session resumed with full context"),
          );
        }
        break;
      }
      case "commands":
        this.composer.applyCommands(event.commands, event.unsupported === true);
        break;
      case "skills":
        this.composer.applySkills(event.skills, event.unsupported === true);
        break;
      case "command_result": {
        if (event.kind === "miss") {
          const name = event.name ? ` /${event.name}` : "";
          new Notice(
            tt(
              `未知命令${name}：该行已按普通消息发送给模型`,
              `Unknown command${name}: the line was sent to the model instead`,
            ),
          );
        } else if (event.kind === "unsupported") {
          this.conversation.pushSystemNote(
            `${tt("命令", "Command")} /${event.name}: ${tt(
              "当前 dsh 不支持本地命令执行",
              "this dsh build does not support local command execution",
            )}`,
          );
          new Notice(tt("当前 dsh 不支持本地命令执行", "This dsh build does not support local command execution"));
          break;
        }
        this.conversation.pushCommand(event.name, event.kind, event.text ?? "");
        this.conversation.scrollBottom();
        break;
      }
      default:
        break;
    }
  }

  sendCurrentInput(text: string, mode: ChatMode): void {
    if (this.isBusy()) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const entry = this.conversation.appendUser(trimmed);
    this.composer.clearInput();
    this.renderStatus();
    // `/name` routing, dsh web semantics: registered commands run locally via
    // the bridge (no model round-trip); anything else - skill gestures or
    // plain prose - goes to the agent as normal.
    const head = trimmed.split(/\s+/)[0] ?? "";
    if (head.startsWith("/") && this.composer.findCommand(head.slice(1)) != null) {
      if (this.plugin.sendCommand({ cmd: "execute_command", line: trimmed })) {
        this.conversation.scrollBottom();
        return;
      }
      entry.text = `⚠️ ${tt("未发送（dsh 进程未运行）：", "Not sent (dsh process is not running): ")}${trimmed}`;
      new Notice(tt("DSH 桥接未运行", "DSH bridge not running"));
      this.conversation.scrollBottom();
      return;
    }
    if (!this.plugin.sendPrompt(trimmed, mode)) {
      entry.text = `⚠️ ${tt("未发送（dsh 进程未运行）：", "Not sent (dsh process is not running): ")}${trimmed}`;
      new Notice(tt("DSH 桥接未运行", "DSH bridge not running"));
    }
    this.conversation.scrollBottom();
  }

  startNewChat(): void {
    this.clearConversation(true);
    // Do not restart the bridge: that used to mint a new persisted session on
    // every click, polluting the shared history. The bridge now drops its live
    // agent and only creates a session when the first real message is sent.
    this.plugin.ensureBridge();
    void this.plugin.sendCommand({ cmd: "new_chat" });
  }

  // ---------------------------------------------------------------- private
  /**
   * Reset the sidebar conversation to the empty New Session state. `skip`
   * suppresses the boot auto-resume — set when the user explicitly asked for
   * a fresh chat, cleared when the archive flow (or anything else) forced the
   * reset without a user intent to start over.
   */
  private clearConversation(skip: boolean): void {
    this.conversation.clear();
    this.activeSessionId = "";
    this.currentSessionTitle = "";
    this.renderHeaderTitle();
    this.skipNextResume = skip;
    this.pendingResume = false;
  }

  /**
   * Pick the session with the newest `updatedAt` for this vault and open it,
   * implementing "On open → resume last conversation". Archived/deleted rows
   * are already filtered out server-side, so the newest here is a live one.
   */
  private resumeNewest(sessions: SessionSummary[]): void {
    let best: SessionSummary | null = null;
    for (const s of sessions) {
      if (s.id === this.activeSessionId) continue;
      if (best == null || (s.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = s;
    }
    const target = best ?? sessions[0] ?? null;
    if (!target) return;
    void this.plugin.sendCommand({ cmd: "open_session", id: target.id });
  }

  /** A turn is streaming or the bridge is still coming up. */
  private isBusy(): boolean {
    const status = this.plugin.bridgeStatus();
    return (
      this.conversation.current !== null ||
      status === "running" ||
      status === "connecting"
    );
  }

  /**
   * Resolve the active session's title from the latest sessions payload and
   * reflect it into the header caption (falls back to 新对话 until known).
   */
  private refreshCurrentTitle(): void {
    const found = this.sessionsCache.find((s) => s.id === this.activeSessionId);
    const title = (found?.title ?? "").trim();
    if (title === this.currentSessionTitle) return;
    this.currentSessionTitle = title;
    this.renderHeaderTitle();
  }

  private renderHeaderTitle(): void {
    this.header.renderTitle(this.currentSessionTitle);
  }

  /** One debounced list_sessions round-trip so header/history titles stay fresh. */
  private scheduleSessionsRefresh(delayMs: number): void {
    if (this.sessionsRefreshTimer != null) return;
    this.sessionsRefreshTimer = window.setTimeout(() => {
      this.sessionsRefreshTimer = null;
      void this.plugin.sendCommand({ cmd: "list_sessions" });
    }, delayMs);
  }

  private renderStatus(): void {
    const status = this.plugin.bridgeStatus();
    const running = status === "running" || this.conversation.current !== null;
    this.header.renderStatus(status);
    this.composer.renderStatus(status, running);
  }

  private onDocPointerDown = (evt: PointerEvent): void => {
    const target = evt.target as Node | null;
    if (!target) return;
    this.composer.handleDocPointerDown(target);
    this.header.handleDocPointerDown(target);
  };

  showBanner(info: string): void {
    if (!this.bannerEl) return;
    this.bannerEl.setText(`⚠️ ${tt("dsh 已停止：", "dsh stopped: ")}${info}`);
    this.bannerEl.removeClass("is-hidden");
  }
  private hideBanner(): void {
    if (!this.bannerEl) return;
    this.bannerEl.addClass("is-hidden");
  }
}