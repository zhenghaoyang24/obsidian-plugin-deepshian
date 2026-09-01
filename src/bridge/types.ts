// Wire protocol shared between the Obsidian plugin and the dsh `deepshian`
// profile bridge (dsh-profile/deepshian/deepshian-bridge.mjs). One JSON object
// per stdio line in each direction.

export type ChatMode = "writable" | "readonly";

export interface ReadyEvent {
  t: "ready";
  model: string;
  cwd: string;
  /** Session id of the agent the bridge booted with. */
  session?: string;
}
export interface TurnStartEvent {
  t: "turn_start";
}
export interface TextEvent {
  t: "text";
  delta: string;
}
export interface ReasoningEvent {
  t: "reasoning";
  delta: string;
}
export interface ToolUseEvent {
  t: "tool_use";
  callId?: string;
  name?: string;
  input: unknown;
}
export interface ToolResultEvent {
  t: "tool_result";
  callId?: string;
  isError: boolean;
  output: string;
  diffs?: unknown[];
}
export interface UsageEvent {
  t: "usage";
  usage: Record<string, number>;
}
export interface TurnEndEvent {
  t: "turn_end";
  reason: string;
  error?: string;
}
export interface ErrorEvent {
  t: "error";
  message: string;
  stack?: string;
}

// ------------------------------------------------------------ session sync
export interface ModelSelection {
  provider: string;
  model: string;
}

/** One catalog row from the bridge's `llm.listModels` fold. */
export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
}

export interface ModelsEvent {
  t: "models";
  current: ModelSelection;
  models: ModelInfo[];
}

export interface SessionSummary {
  id: string;
  title?: string;
  updatedAt?: number;
  live?: boolean;
}

export interface SessionsEvent {
  t: "sessions";
  sessions: SessionSummary[];
  cwd?: string;
  /** Echoed by the bridge when this payload answers an archive_session command. */
  archived?: string;
}

/** One folded turn of a restored session's persisted history. */
export interface ReplayTool {
  name: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
}

export interface ReplayTurn {
  user?: string;
  assistant?: string;
  usage?: Record<string, number>;
  tools?: ReplayTool[];
}

export interface SessionOpenedEvent {
  t: "session_opened";
  id: string;
  model: string;
  turns: ReplayTurn[];
}

/** A fresh session was minted lazily (first prompt of a new conversation). */
export interface SessionCreatedEvent {
  t: "session_created";
  id: string;
  model: string;
}

// -------------------------------------------------------- slash commands
/** One row of the `/` picker's command section (dsh `commands` registry). */
export interface CommandInputDescriptor {
  hint?: string;
  images?: boolean;
}

export interface CommandInfo {
  name: string;
  description: string;
  input: CommandInputDescriptor | null;
}

/** One row of the `/` picker's skill section (dsh SkillRegistry). */
export interface SkillInfo {
  name: string;
  description: string;
  provider: string;
  userInvocable: boolean;
}

export interface CommandsEvent {
  t: "commands";
  commands: CommandInfo[];
  /** True when this dsh base ships no command registry — the picker degrades. */
  unsupported?: boolean;
}

export interface SkillsEvent {
  t: "skills";
  skills: SkillInfo[];
  /** True when this dsh base ships no skill registry — the picker degrades. */
  unsupported?: boolean;
}

export type CommandResultKind = "success" | "error" | "miss" | "unsupported";

export interface CommandResultEvent {
  t: "command_result";
  id: string | null;
  name: string;
  kind: CommandResultKind;
  text?: string;
}

export type DshEvent =
  | ReadyEvent
  | TurnStartEvent
  | TextEvent
  | ReasoningEvent
  | ToolUseEvent
  | ToolResultEvent
  | UsageEvent
  | TurnEndEvent
  | ErrorEvent
  | ModelsEvent
  | SessionsEvent
  | SessionOpenedEvent
  | SessionCreatedEvent
  | CommandsEvent
  | SkillsEvent
  | CommandResultEvent;

export type BridgeStatus = "stopped" | "connecting" | "ready" | "running";
