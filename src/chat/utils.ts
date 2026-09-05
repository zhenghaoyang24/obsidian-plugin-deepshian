import type { DshEvent, ModelSelection } from "../bridge/types";

/**
 * The session a turn-scoped event belongs to, or undefined for events that are
 * not scoped to a conversation (models / sessions / commands listings). The
 * sidebar uses this to drop another session's stream while it is on screen —
 * background turns keep running and are replayed in full on switch-back.
 */
export function eventSession(event: DshEvent): string | undefined {
  if (
    event.t === "turn_start" ||
    event.t === "text" ||
    event.t === "reasoning" ||
    event.t === "tool_use" ||
    event.t === "tool_result" ||
    event.t === "usage" ||
    event.t === "turn_end" ||
    event.t === "error" ||
    event.t === "command_result"
  ) {
    return event.session;
  }
  return undefined;
}

/** One-line human preview used by tool summaries and reasoning titles. */
export function previewLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

/** One-line human preview of a tool call's arguments. */
export function summarizeInput(input: unknown): string {
  if (input == null || typeof input !== "object") return "";
  const keys = ["command", "file_path", "path", "query", "pattern", "url", "prompt", "skill"];
  for (const k of keys) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim() !== "") return previewLine(v);
  }
  try {
    return previewLine(JSON.stringify(input));
  } catch {
    return "";
  }
}

/** Split a bridge "provider/model" display string back into its selection. */
export function parseModelString(raw: string): ModelSelection | null {
  const slash = raw.indexOf("/");
  if (slash <= 0) return null;
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
}

/** Locale time-of-day/date formatting for history rows. */
export function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(ms);
  }
}

// ------------------------------------------------------------ clipboard io
/** Write text to the system clipboard; falls back to a hidden textarea copy. */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can reject when the window lacks focus; fall back to the
    // legacy execCommand path, which works there.
  }
  try {
    const ta = document.body.createEl("textarea", { cls: "dsh-clipboard-ghost" });
    ta.value = text;
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
