import { Notice } from "obsidian";
import { t as tt } from "../i18n";
import { statusText } from "./types";
import { formatTime } from "./utils";
import { ICON_ARCHIVE, ICON_HISTORY, ICON_PLUS, svgIcon } from "./icons";
import type DshBridgePlugin from "../main";
import type { BridgeStatus, SessionSummary } from "../bridge/types";

export interface ChatHeaderCallbacks {
  onNewChat(): void;
  onOpenSession(id: string): void;
  /** Whether a turn is streaming — archives of the live session are disabled then. */
  isBusy(): boolean;
}

/**
 * Owns the header row (status chip, session title, history dropdown button,
 * new-session pill) and the session-history panel that hangs beneath it.
 */
export class ChatHeader {
  private headerEl!: HTMLElement;
  private statusChip!: HTMLElement;
  private titleEl!: HTMLElement;
  private historyBtn!: HTMLButtonElement;
  private historyPanelEl!: HTMLElement;
  private historyTitleEl!: HTMLElement;
  private historyListEl!: HTMLElement;
  private historyFootEl!: HTMLElement;
  private newChatBtn!: HTMLButtonElement;
  private newChatLabelEl!: HTMLElement;

  private sessionsCache: SessionSummary[] = [];
  private activeId = "";

  constructor(
    private contentEl: HTMLElement,
    private plugin: DshBridgePlugin,
    private callbacks: ChatHeaderCallbacks,
  ) {}

  build(): void {
    this.headerEl = this.contentEl.createDiv({ cls: "dsh-header" });
    this.statusChip = this.headerEl.createSpan({ cls: "dsh-status", text: "stopped" });
    this.titleEl = this.headerEl.createSpan({
      cls: "dsh-title",
      text: tt("新对话", "New chat"),
    });

    // Session-history dropdown; lives inside .dsh-header (position:relative)
    // so it anchors right beneath the header instead of off-view.
    this.historyBtn = this.headerEl.createEl("button", {
      cls: "clickable-icon dsh-iconbtn",
      attr: { "aria-label": tt("历史会话", "Session history"), "aria-haspopup": "true" },
    });
    this.historyBtn.append(svgIcon(ICON_HISTORY));
    this.historyBtn.addEventListener("click", () => {
      if (this.historyPanelEl.hasAttribute("hidden")) this.openHistory();
      else this.closeHistory();
    });

    // Explicit labeled pill — unmistakable entry point for a fresh conversation.
    this.newChatBtn = this.headerEl.createEl("button", {
      cls: "dsh-newchat-btn",
      attr: { type: "button", "aria-label": tt("新会话", "New session") },
    });
    this.newChatBtn.createSpan({ cls: "dsh-newchat-icon" }).append(svgIcon(ICON_PLUS));
    this.newChatLabelEl = this.newChatBtn.createSpan({
      cls: "dsh-newchat-label",
      text: tt("新会话", "New session"),
    });
    this.newChatBtn.addEventListener("click", () => this.callbacks.onNewChat());

    // Dropdown panel listing this workspace's persisted sessions.
    this.historyPanelEl = this.headerEl.createDiv({
      cls: "dshc-history",
      attr: { hidden: "" },
    });
    this.historyTitleEl = this.historyPanelEl.createDiv({
      cls: "dshc-history-title",
      text: tt("历史会话", "Session history"),
    });
    this.historyListEl = this.historyPanelEl.createDiv({ cls: "dshc-history-list" });
    this.historyFootEl = this.historyPanelEl.createDiv({
      cls: "dshc-history-foot",
      text: tt(
        "会话与 dsh web 共享同一存储，归档双向同步；同一会话请避免两端同时使用。",
        "Sessions share storage with dsh web, archiving syncs both ways; use one surface at a time.",
      ),
    });
  }

  /** Latest sessions payload; painted by renderSessions()/openHistory(). */
  setSessions(sessions: SessionSummary[]): void {
    this.sessionsCache = sessions;
  }

  /** Header caption: current session title (falls back to 新对话). */
  renderTitle(title: string): void {
    const text = title || tt("新对话", "New chat");
    this.titleEl.setText(text);
    this.titleEl.setAttr("aria-label", tt(`当前会话：${text}`, `Current session: ${text}`));
  }

  /** Status chip + history button enabled state. */
  renderStatus(status: BridgeStatus): void {
    // The chip is a pure status word now; the header title carries the identity.
    this.statusChip.setText(statusText(status));
    this.statusChip.setAttr("data-status", status);
    const alive = status !== "stopped" && status !== "connecting";
    this.historyBtn.disabled = !alive;
  }

  /** Paint the cached session rows (newest first, active one marked). */
  renderSessions(activeId: string): void {
    this.activeId = activeId;
    this.historyListEl.empty();
    if (this.sessionsCache.length === 0) {
      this.historyListEl.createDiv({
        cls: "dshc-history-empty",
        text: tt("本工作区暂无历史会话", "No sessions in this workspace yet"),
      });
      return;
    }
    for (const s of this.sessionsCache) {
      const entry = this.historyListEl.createDiv({ cls: "dshc-history-entry" });
      const row = entry.createEl("button", {
        cls: "dshc-history-row",
        attr: { type: "button", "data-session": s.id },
      });
      row.toggleClass("active", s.id === this.activeId);
      const textCol = row.createDiv({ cls: "dshc-history-text" });
      textCol.createDiv({ cls: "dshc-history-name", text: s.title || tt("未命名会话", "Untitled session") });
      const metaParts: string[] = [];
      if (s.live) metaParts.push(tt("进行中", "live"));
      if (s.updatedAt != null && Number(s.updatedAt) > 0) {
        metaParts.push(formatTime(Number(s.updatedAt)));
      }
      if (metaParts.length > 0) {
        textCol.createDiv({ cls: "dshc-history-meta", text: metaParts.join(" · ") });
      }
      row.addEventListener("click", () => {
        if (s.id === this.activeId) {
          this.closeHistory();
          return;
        }
        this.clearPendingRows();
        row.addClass("pending");
        this.callbacks.onOpenSession(s.id);
      });

      // Archive action, hover-revealed like a dsh web row affordance. One
      // click archives — no confirmation, matching the web surface — and the
      // bridge echoes a fresh sessions payload that drops the row here while
      // dsh web (same archive set) hides it on its next listing.
      const archive = entry.createEl("button", {
        cls: "dshc-history-archive",
        attr: {
          type: "button",
          "aria-label": tt("归档会话", "Archive session"),
          title: tt("归档会话（与 dsh web 同步）", "Archive session (synced with dsh web)"),
        },
      });
      archive.append(svgIcon(ICON_ARCHIVE));
      // Never archive the live session mid-turn: the bridge would reject the
      // switch anyway; disabling the affordance is the honest state.
      archive.disabled = s.id === this.activeId && this.callbacks.isBusy();
      archive.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.archiveSession(s, entry);
      });
    }
  }

  closeHistory(): void {
    this.historyPanelEl.setAttribute("hidden", "");
  }

  /** Drop the "pending" highlight from all history rows (session opened). */
  clearPendingRows(): void {
    for (const row of Array.from(this.historyListEl.children) as HTMLElement[]) {
      row.querySelector<HTMLElement>(".dshc-history-row")?.removeClass("pending");
    }
  }

  /** Close the history panel when a pointerdown lands outside it. */
  handleDocPointerDown(target: Node | null): void {
    if (!this.historyPanelEl.hasAttribute("hidden")) {
      if (
        !this.historyPanelEl.contains(target) &&
        !this.historyBtn.contains(target)
      ) {
        this.closeHistory();
      }
    }
  }

  /** Re-paint locale-dependent labels after a language switch. */
  relocalize(): void {
    this.historyBtn.setAttribute("aria-label", tt("历史会话", "Session history"));
    this.newChatBtn.setAttribute("aria-label", tt("新会话", "New session"));
    this.newChatLabelEl.setText(tt("新会话", "New session"));
    this.historyTitleEl.setText(tt("历史会话", "Session history"));
    this.historyFootEl.setText(
      tt(
        "会话与 dsh web 共享同一存储，归档双向同步；同一会话请避免两端同时使用。",
        "Sessions share storage with dsh web, archiving syncs both ways; use one surface at a time.",
      ),
    );
    this.renderSessions(this.activeId);
  }

  // ---------------------------------------------------------------- private
  private openHistory(): void {
    if (this.plugin.bridgeStatus() === "stopped") {
      new Notice(tt("DSH 未运行，无法读取历史会话", "DSH is not running; history unavailable"));
      return;
    }
    this.historyPanelEl.removeAttribute("hidden");
    this.renderSessions(this.activeId);
    void this.plugin.sendCommand({ cmd: "list_sessions" });
  }

  /** Request one session's archival; the echoed sessions payload does the rest. */
  private archiveSession(s: SessionSummary, entry: HTMLElement): void {
    if (this.plugin.bridgeStatus() === "stopped") {
      new Notice(tt("DSH 未运行，无法归档会话", "DSH is not running; archive unavailable"));
      return;
    }
    entry.addClass("archiving"); // optimistic fade until the payload round-trips
    if (!this.plugin.sendCommand({ cmd: "archive_session", id: s.id })) {
      entry.removeClass("archiving");
      new Notice(tt("DSH 未运行，无法归档会话", "DSH is not running; archive unavailable"));
    }
  }
}