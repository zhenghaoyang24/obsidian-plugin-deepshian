// DeepSeek Harness ↔Obsidian bridge runner.
// A Cordis plugin (inserted by the `deepshian` profile's cordis.patch.yml) that
// drives the real dsh Agent core and exposes it as a tiny, stable JSONL protocol
// over stdio:
//
//   inbound (plugin ↔dsh), one JSON object per line:
//     {"prompt":"...","mode":"writable"|"readonly"}
//     {"cmd":"list_models"}
//     {"cmd":"set_model","provider":"...","model":"..."}
//     {"cmd":"list_sessions"}
//     {"cmd":"open_session","id":"<sessionId>"}
//     {"cmd":"new_chat"}                    detach the sidebar; running sessions KEEP running
//     {"cmd":"stop","id":"<sessionId>"?}    cancel one session's turn (default: the active one)
//     {"cmd":"archive_session","id":"<sessionId>"}   archive durably (the SAME global set dsh web maintains)
//     {"cmd":"list_commands"}               the `/` picker's command registry (same service dsh web)
//     {"cmd":"execute_command","line":"/goal ..."}   run a slash command locally, no model round-trip
//     {"cmd":"list_skills"}                 the `/` picker's skill catalog (same provider dsh web)
//
//   outbound (dsh ↔plugin), one JSON object per line:
//     {"t":"ready","model":"...","cwd":"..."}   (boots WITHOUT a session)
//     {"t":"models","current":{"provider","model"},"models":[{provider,id,name}]}
//     {"t":"sessions","sessions":[{id,title,updatedAt,live,running}],"archived":"<id>"}
//         (deleted + archived excluded; `archived` echoes the id an archive_session answered)
//     {"t":"session_status","id","running","live"}  pushed the instant a turn starts or settles
//     {"t":"session_opened","id":"...","model":"...","running":bool,"turns":[{user,assistant,tools:[...]}]}
//     {"t":"session_created","id":"...","model":"..."}   lazy mint on the first prompt
//     {"t":"commands","commands":[{"name","description","input"}],"unsupported?":true}
//     {"t":"skills","skills":[{"name","description","provider","userInvocable"}],"unsupported?":true}
//     {"t":"command_result","id","name","kind":"success"|"error"|"miss"|"unsupported","text"?}
//     {"t":"turn_start"|"text"|"reasoning"|"tool_use"|"tool_result"|"usage"|"turn_end"|"error",
//      "session":"<sessionId>", ...}
//
//   Every turn-scoped event carries the emitting session's id: the bridge runs
//   a POOL of live agents, so several conversations can stream at once and the
//   sidebar routes each line to the conversation it belongs to.
//
// Sessions persist through the shared `$DSH_HOME/sessions` JSONL backend, keyed
// by project directory, so every conversation driven here is the SAME durable
// record dsh web lists for this workspace ↔open either surface against the
// same vault and you see one shared history. Etiquette: treat a session as
// single-writer; switch ownership here before continuing it in dsh web.
//
// Workspace sync (both directions, all inside this bridge):
//   - web -> plugin: the session listing matches the vault by canonical
//     `fs.realpath` cwd (raw spelling first, canon second), so conversations
//     dsh web created under the vault's workspace appear here even when the
//     two surfaces spell the directory differently;
//   - plugin -> web: every listing refresh folds this vault's unaccounted
//     persisted sessions into a vault-named workspace record inside the
//     shared `$DSH_HOME/storages/workspace.json` domain file (the same file
//     web's registry persists), so web groups them under a workspace titled
//     after the vault root. Web sees new records on its next host start; a
//     running web host may republish over this write and the next refresh
//     re-applies it idempotently.
//
// A session is minted LAZILY, only when the first real prompt is sent: booting
// the bridge, opening the sidebar, or clicking "new chat" never registers an
// empty conversation in the shared session store.
//
// The bridge keeps a POOL of live agents (one per open session), so starting a
// new chat or switching conversations never interrupts a turn that is already
// streaming — dsh web behaves the same way. "Active" only means "the session
// the sidebar is currently displaying"; every other session in the pool keeps
// running in the background, and its events keep flowing out tagged with its
// id. Switching back replays the live agent's in-memory log (which includes
// the still-open turn) and the stream simply continues from there.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";
import { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";

export const name = "deepshian-bridge";

/** Debug passthrough: DSH_OBSIDIAN_DEBUG=1 echoes every non-noise session event. */
const DEBUG = process.env.DSH_OBSIDIAN_DEBUG === "1";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b.text === "string" ? b.text : "")).join("");
}

function parseArguments(raw) {
  if (typeof raw !== "string" || raw === "") return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : { value: v };
  } catch {
    return { raw };
  }
}

/** Normalize event/header timestamps (epoch ms number or ISO string) to ms. */
function toMillis(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Memoizing `fs.realpath` wrapper — the workspace identity canon used by BOTH
 * directions of vault/web sync. dsh web canonicalizes every directory through
 * `fs.realpath` (drive-letter case, short names, symlinks, trailing
 * separators all collapse), while Obsidian hands the bridge its own basePath
 * spelling; comparing raw strings is exactly what broke cross-surface
 * session visibility. A failed realpath resolves to `null` so callers can
 * fall back to raw equality instead of failing the listing.
 */
function makeCanonicalResolver() {
  const cache = new Map();
  return async (path) => {
    const key = String(path);
    if (cache.has(key)) return cache.get(key);
    const canon = await realpath(key).catch(() => null);
    cache.set(key, canon);
    return canon;
  };
}

/**
 * Workspace-sync core (pure apart from the injected `resolve`): idempotently
 * fold one vault directory into a workspace-registry document — the same
 * `workspace.json` domain dsh web persists — so conversations driven from
 * this bridge appear in web under a workspace named after the vault root,
 * mirroring web's own bootstrap naming (`basename(path)`).
 *
 * Web semantics mirrored exactly:
 *   - one workspace per canonical directory path; an existing record is
 *     reused and never retitled (`createCanonical` behavior);
 *   - a new record is PREPENDED to `global.workspaceIds` (registry `create`
 *     order) and its id must always sit in that order (registry validation
 *     rejects any table row missing from it);
 *   - only sessions accounted by NO workspace are adopted (bootstrap rule);
 *     accounting and the archive set are orthogonal layers, so archived ids
 *     stay adoptable and an unarchive restores the position;
 *   - `initialized` is never flipped here: when the registry has not
 *     bootstrapped yet, web's own startup bootstrap merges this record by
 *     canonical path;
 *   - adoption short-circuits while a registry `pendingMutation` marker is
 *     present, so a crashed web-side operation is never fought; the next
 *     listing refresh retries.
 *
 * Returns true when the document changed and must be re-published.
 */
async function adoptVaultWorkspace(doc, vaultCanon, rows, resolve, nowIso) {
  const global = doc?.global;
  if (!global || typeof global !== "object") return false;
  if (global.pendingMutation && typeof global.pendingMutation === "object") return false;
  const records = doc.tables?.workspaces;
  if (!records || typeof records !== "object" || Array.isArray(records)) return false;

  // sessionId -> workspaceId, first writer wins; duplicate accounting in the
  // input is pre-existing corruption this fold must not amplify.
  const accounted = new Map();
  for (const [wsId, rec] of Object.entries(records)) {
    if (!rec || typeof rec !== "object") continue;
    const ids = Array.isArray(rec.sessionIds) ? rec.sessionIds : [];
    for (const sid of ids) {
      const key = String(sid);
      if (!accounted.has(key)) accounted.set(key, wsId);
    }
  }

  let changed = false;
  let wsId = null;
  let record = null;
  for (const [id, rec] of Object.entries(records)) {
    if (!rec || typeof rec !== "object") continue;
    if (typeof rec.path !== "string" || rec.path === "") continue;
    if ((await resolve(rec.path)) === vaultCanon) {
      wsId = id;
      record = rec;
      break;
    }
  }
  if (!wsId) {
    wsId = randomUUID();
    record = {
      path: vaultCanon,
      title: basename(vaultCanon),
      sessionIds: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    records[wsId] = record;
    changed = true;
  }
  // Order invariant: every table row must sit in workspaceIds or web's
  // startup validation fails loud.
  if (!Array.isArray(global.workspaceIds)) global.workspaceIds = [];
  if (!global.workspaceIds.some((x) => String(x) === wsId)) {
    global.workspaceIds.unshift(wsId);
    changed = true;
  }
  if (!Array.isArray(record.sessionIds)) record.sessionIds = [];

  const candidates = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = r?.header?.id;
    const cwd = r?.header?.cwd;
    if (r?.persisted !== true) continue;
    if (typeof id !== "string" || id === "") continue;
    if (typeof cwd !== "string" || cwd === "") continue;
    if (accounted.has(id)) continue;
    if (cwd === vaultCanon || (await resolve(cwd)) === vaultCanon) candidates.push(r);
  }
  if (candidates.length > 0) {
    candidates.sort(
      (a, b) =>
        (toMillis(b.header.createdAt) ?? 0) - (toMillis(a.header.createdAt) ?? 0) ||
        String(a.header.id).localeCompare(String(b.header.id)),
    );
    const known = new Set(record.sessionIds.map(String));
    const adopt = candidates.map((r) => String(r.header.id)).filter((id) => !known.has(id));
    if (adopt.length > 0) {
      // Newest first, prepended — same position convention as web's
      // `attachSession`, so display order stays "newest at top".
      record.sessionIds = [...adopt, ...record.sessionIds.map(String)];
      record.updatedAt = nowIso;
      changed = true;
    }
  }
  return changed;
}

/**
 * Map one streaming session event onto the flat JSONL protocol. `sid` is the
 * emitting session, stamped on every event so a sidebar watching another
 * conversation can tell whose turn a line belongs to.
 */
function mapEvent(event, sid) {
  const d = event.data;
  const at = sid ? { session: sid } : {};
  switch (event.type) {
    case "turn/start":
      emit({ t: "turn_start", ...at });
      break;
    case "assistant/chunk": {
      const c = d?.chunk;
      if (c == null) break;
      if (c.type === "text-delta") emit({ t: "text", ...at, delta: c.text ?? "" });
      else if (c.type === "reasoning-delta") emit({ t: "reasoning", ...at, delta: c.text ?? "" });
      else if (c.type === "usage") emit({ t: "usage", ...at, usage: c.usage });
      break;
    }
    case "tool/call":
      // Dedicated start-marker per tool invocation; arguments is a JSON string.
      emit({
        t: "tool_use",
        ...at,
        callId: d?.callId,
        name: d?.name,
        input: parseArguments(d?.arguments),
      });
      break;
    case "tool/result": {
      // Shape: data.message.content[0] = {type:"tool-result", toolCallId,
      // content:[{type:"text",text}], isError}; meta.diffs may carry file diffs.
      const first = d?.message?.content?.find((b) => b?.type === "tool-result");
      const callId = first?.toolCallId ?? d?.callId;
      const diffs = Array.isArray(d?.meta?.diffs) ? d.meta.diffs : [];
      emit({
        t: "tool_result",
        ...at,
        callId,
        isError: first?.isError === true,
        output: textOf(first?.content),
        ...(diffs.length > 0 ? { diffs } : {}),
      });
      break;
    }
    case "turn/end":
      emit({
        t: "turn_end",
        ...at,
        reason: d?.reason?.kind ?? "unknown",
        error: d?.reason?.error?.message,
      });
      break;
    default:
      break;
  }
}

/**
 * Fold one loaded session's event log into compact replay turns for the
 * sidebar: one entry per turn with the user prompt, assistant text (streaming
 * chunk concatenation preferred, final assistant/message as fallback), and
 * tool call/result pairs. Purely structural events are dropped.
 * `events` may be raw session events or persistence-inspect records.
 */
function foldHistory(events) {
	const turns = [];
	let cur = null;

  const fresh = () => ({ user: "", assistant: "", finalText: null, tools: [], usage: undefined });
  const flush = () => {
    if (!cur) return;
    if (!cur.assistant && cur.finalText != null) cur.assistant = cur.finalText;
    delete cur.finalText;
    if (cur.user.trim() !== "" || cur.assistant.trim() !== "" || cur.tools.length > 0) {
      turns.push(cur);
    }
    cur = null;
  };

  for (const ev of events) {
    const d = ev?.data;
    switch (ev.type) {
      case "turn/start":
        flush();
        cur = fresh();
        break;
      case "user/message": {
        // Live shape: data is the message itself ({content, source, role, id}).
        const msgObj = d?.message ?? d;
        if (msgObj?.source?.kind !== "user") break; // skip injected / system-sourced
        if (!cur) cur = fresh();
        const text = textOf(msgObj?.content);
        if (text) cur.user += (cur.user ? "\n" : "") + text;
        break;
      }
      case "assistant/chunk": {
        const c = d?.chunk;
        if (!cur || c == null) break;
        if (c.type === "text-delta") cur.assistant += c.text ?? "";
        else if (c.type === "usage" && c.usage) cur.usage = c.usage;
        break;
      }
      case "assistant/message":
        if (cur) cur.finalText = textOf(d?.message?.content);
        break;
      case "tool/call":
        if (!cur) cur = fresh();
        cur.tools.push({
          callId: d?.callId,
          name: d?.name,
          input: parseArguments(d?.arguments),
          output: "",
          isError: false,
          filled: false,
        });
        break;
      case "tool/result": {
        if (!cur) break;
        const first = d?.message?.content?.find((b) => b?.type === "tool-result");
        const callId = first?.toolCallId ?? d?.callId;
        const tool =
          [...cur.tools].reverse().find((x) => x.callId === callId && !x.filled) ??
          [...cur.tools].reverse().find((x) => !x.filled);
        if (tool) {
          tool.output = textOf(first?.content);
          tool.isError = first?.isError === true;
          tool.filled = true;
        }
        break;
      }
      case "turn/end":
        flush();
        break;
      default:
        break;
    }
  }
  flush();
  for (const t of turns) {
    for (const tool of t.tools) {
      delete tool.callId;
      delete tool.filled;
    }
  }
  return turns;
}

async function run(ctx) {
  await ctx.get("loader")?.await();

  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  const sessions = ctx.get("sessions");
  if (!agents || !defaultModel || !sessions) {
    emit({ t: "error", message: "deepshian-bridge: missing core services (agents / agentDefaultModel / sessions)" });
    process.exit(1);
    return;
  }
  const llm = ctx.get("llm");
  const sessionQuery = ctx.get("sessionQuery");

  /**
   * Live selection reference handed to installModelSelection: every system-prompt
   * assembly re-reads the settings-backed default, so a `/set_model` picked in
   * the sidebar (or a change made on dsh web's Models page) takes effect on the
   * next message without touching the running conversation.
   */
  const liveSelection = {
    get current() {
      return defaultModel.currentSelection();
    },
    assembled: void 0,
  };

  /**
   * Agent pool: one live agent per open session, keyed by session id. This is
   * what lets a turn keep streaming while the sidebar moves to another
   * conversation. `activeId` only records which session the UI is displaying —
   * it is NOT "the only session allowed to run".
   *
   * Concurrency is native: dsh's own AgentRegistry is a Map keyed by session
   * id and holds as many agents as you create. The old code threw most of that
   * away by disposing the previous agent on every switch.
   */
  const handles = new Map(); // sessionId -> { agent, dispose }
  let activeId = "";
  let opening = false; // session switch in flight

  /** In-flight turn count per session; > 0 means "streaming right now". */
  const pendingBySession = new Map();
  /** Total in-flight turns — the stdin-EOF shutdown gate. */
  let pending = 0;

  /** Pool ceiling. Only idle, off-screen agents are ever evicted. */
  const MAX_LIVE_AGENTS = 5;

  function isRunning(id) {
    if ((pendingBySession.get(id) ?? 0) > 0) return true;
    return handles.get(id)?.agent?.status === "running";
  }

  /** Push one session's run state to the sidebar. */
  function noteSessionStatus(id) {
    emit({ t: "session_status", id: String(id), running: isRunning(id), live: handles.has(id) });
  }

  function markTurnStart(id) {
    pending += 1;
    const next = (pendingBySession.get(id) ?? 0) + 1;
    pendingBySession.set(id, next);
    if (next === 1) noteSessionStatus(id);
  }

  function markTurnEnd(id) {
    const next = Math.max(0, (pendingBySession.get(id) ?? 1) - 1);
    pendingBySession.set(id, next);
    pending = Math.max(0, pending - 1);
    if (next === 0) noteSessionStatus(id);
  }

  /** Drop one agent from the pool. Callers must settle its turn first. */
  function disposeSession(id) {
    const h = handles.get(id);
    if (!h) return false;
    handles.delete(id);
    if (activeId === id) activeId = "";
    try {
      h.dispose?.();
    } catch {
      /* prior agent already gone */
    }
    pendingBySession.delete(id);
    noteSessionStatus(id);
    return true;
  }

  /** Mark one session as most-recently used (Map order is the LRU order). */
  function touch(id) {
    const h = handles.get(id);
    if (!h) return;
    handles.delete(id);
    handles.set(id, h);
  }

  /**
   * Keep the pool bounded: evict the least-recently used agents that are idle
   * and off-screen. A running session is never evicted — that is the entire
   * point of the pool — and neither is the one the sidebar is showing. The
   * session stays persisted, so opening it later simply resumes it.
   */
  function trimPool() {
    if (handles.size <= MAX_LIVE_AGENTS) return;
    for (const id of [...handles.keys()]) {
      if (handles.size <= MAX_LIVE_AGENTS) break;
      if (id === activeId || isRunning(id)) continue;
      disposeSession(id);
    }
  }

  /**
   * One wire-up of the JSONL mapper for the whole pool. `session/event` is
   * emitted per session scope, so a single root listener observes every
   * conversation; the membership test drops events from sessions we do not
   * own — notably subagents, which carry their own session ids.
   */
  const disposeEventTap = ctx.on("session/event", (session, event) => {
    const sid = String(session?.id ?? "");
    if (sid === "" || !handles.has(sid)) return;
    const noisy =
      event.type === "assistant/chunk" &&
      ["text-delta", "reasoning-delta", "usage"].includes(event.data?.chunk?.type);
    if (DEBUG && !noisy) {
      emit({ t: "dbg", type: event.type, seq: event.seq, data: event.data });
    }
    try {
      mapEvent(event, sid);
    } catch (err) {
      emit({
        t: "error",
        session: sid,
        message: `event map failed: ${String(err)}`,
        stack: String(err?.stack ?? ""),
      });
    }
  });

  async function startFresh() {
    const sessionId = SessionId(`deepshian-${randomUUID()}`);
    const selection = defaultModel.currentSelection();
    const h = await agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, liveSelection);
      },
    });
    await h.agent.whenIdle();
    handles.set(String(sessionId), h);
    activeId = String(sessionId);
    trimPool();
    emit({
      t: "session_created",
      id: String(sessionId),
      model: `${selection.provider}/${selection.model}`,
    });
    noteSessionStatus(String(sessionId));
    return h;
  }

  /** Point the sidebar at one pooled session (never disposes anything). */
  function setActive(id) {
    activeId = String(id);
    touch(activeId);
  }

  /** The agent the sidebar is on, or null when there is nothing to talk to. */
  function activeHandle() {
    return activeId === "" ? null : handles.get(activeId) ?? null;
  }

  async function sendModels() {
    const models = [];
    if (llm) {
      for (const provider of llm.adapters.keys()) {
        try {
          for (const m of await llm.listModels(provider)) {
            models.push({ provider: m.provider, id: m.id, name: m.name });
          }
        } catch {
          /* provider without an enumerable catalog still stays selectable via current */
        }
      }
    }
    emit({ t: "models", current: defaultModel.currentSelection(), models });
  }

  /**
   * Resolve the shared workspace-state file. The workspace service only ships
   * in web bundles, not the deepshian profile, so when it is absent the
   * registry-global archive set lives in `$DSH_HOME/storages/workspace.json`
   * that web (and the archive manager) persists — same `$DSH_HOME`, same
   * session store, same archive set.
   */
  function workspaceStateFile() {
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ""
      ? process.env.DSH_HOME
      : join(homedir(), ".dsh");
    return join(home, "storages", "workspace.json");
  }

  /**
   * Resolve the registry-global archive set. Deleted sessions are handled by
   * `listSessions` already: their transcript directory is gone, so they no
   * longer materialize.
   */
  async function readArchivedIds() {
    let ids = [];
    try {
      const workspaces = ctx.get("workspaces");
      if (workspaces && Array.isArray(workspaces.archivedSessionIds)) {
        ids = workspaces.archivedSessionIds.map(String);
      } else {
        const text = await readFile(workspaceStateFile(), "utf8");
        const arr = JSON.parse(text)?.global?.archivedSessionIds;
        if (Array.isArray(arr)) ids = arr.map(String);
      }
    } catch {
      /* no archive state available — treat as empty */
    }
    return new Set(ids);
  }

  /**
   * Append one session id to the durable archive set exactly the way the web
   * registry would: idempotent (an already archived id is a no-op), preserves
   * every other field, and writes atomically via tmp-file + rename so a crash
   * can never leave a half-written workspace.json. When the file does not
   * exist yet, mint the domain's initial shape so later web/plugin reads are
   * stable.
   */
  async function archiveViaFile(id) {
    const file = workspaceStateFile();
    let doc = null;
    try {
      doc = JSON.parse(await readFile(file, "utf8"));
    } catch {
      doc = null;
    }
    if (!doc || typeof doc !== "object") {
      doc = {
        unit: { name: "workspace", version: 2 },
        global: { initialized: false, workspaceIds: [], archivedSessionIds: [] },
        tables: { workspaces: {} },
      };
    }
    if (!doc.global || typeof doc.global !== "object") doc.global = {};
    const ids = Array.isArray(doc.global.archivedSessionIds)
      ? doc.global.archivedSessionIds.map(String)
      : [];
    if (ids.includes(String(id))) return; // already archived — no write
    doc.global.archivedSessionIds = [...ids, String(id)];
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    await rename(tmp, file);
  }

  /** Archive one session in the registry (web bundles) or the shared file. */
  async function archiveSession(id) {
    const wanted = String(id);
    const svc = ctx.get("workspaces");
    if (svc && typeof svc.archiveSession === "function") {
      // Full registry path: publishes to web clients live, updates the same file.
      await svc.archiveSession(SessionId(wanted));
      return;
    }
    await archiveViaFile(wanted);
  }

  /**
   * Vault -> web workspace sync driver: read the shared workspace registry
   * file, fold this vault's unaccounted persisted sessions into the
   * vault-named workspace, and republish atomically — the exact file and
   * format dsh web maintains. Best-effort: every failure is swallowed
   * (debug-visible) so listing never breaks. Web picks the result up on its
   * next host start; a running web host keeps its in-memory snapshot and may
   * republish over this write, which the next idempotent run re-applies.
   */
  async function syncVaultWorkspace(rows) {
    if (!sessionQuery) return false;
    const file = workspaceStateFile();
    let text = null;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    let doc;
    if (text == null) {
      // Same initial shape the file-based archive path mints.
      doc = {
        unit: { name: "workspace", version: 2 },
        global: { initialized: false, workspaceIds: [], archivedSessionIds: [] },
        tables: { workspaces: {} },
      };
    } else {
      doc = JSON.parse(text);
      if (doc?.unit?.name !== "workspace" || doc?.unit?.version !== 2) {
        if (DEBUG) emit({ t: "dbg", type: "workspace_sync_skipped", data: "foreign workspace.json unit header" });
        return false;
      }
    }
    if (!doc.global || typeof doc.global !== "object") {
      doc.global = { initialized: false, workspaceIds: [], archivedSessionIds: [] };
    }
    if (!Array.isArray(doc.global.workspaceIds)) doc.global.workspaceIds = [];
    if (!Array.isArray(doc.global.archivedSessionIds)) doc.global.archivedSessionIds = [];
    if (!doc.tables || typeof doc.tables !== "object" || Array.isArray(doc.tables)) doc.tables = {};
    if (
      !doc.tables.workspaces ||
      typeof doc.tables.workspaces !== "object" ||
      Array.isArray(doc.tables.workspaces)
    ) {
      doc.tables.workspaces = {};
    }

    const resolve = makeCanonicalResolver();
    const vaultCanon = await resolve(process.cwd());
    if (vaultCanon == null) return false; // vault directory not resolvable right now

    let all = rows;
    if (!Array.isArray(all)) all = await sessionQuery.listSessions();

    const changed = await adoptVaultWorkspace(doc, vaultCanon, all, resolve, new Date().toISOString());
    if (!changed) return false;

    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    await rename(tmp, file);
    if (DEBUG) emit({ t: "dbg", type: "workspace_synced", data: vaultCanon });
    return true;
  }

  async function sendSessions(archivedId) {
    const out = [];
    const archived = await readArchivedIds();
    if (sessionQuery) {
      const all = await sessionQuery.listSessions();
      // Fold this vault's unaccounted sessions into the shared workspace
      // registry BEFORE listing (best-effort; failures never break listing).
      try {
        await syncVaultWorkspace(all);
      } catch (err) {
        if (DEBUG) emit({ t: "dbg", type: "workspace_sync_failed", data: String(err?.message ?? err) });
      }
      // Vault-membership test: raw equality first (the bridge's own cwd
      // spelling), then the canonical `fs.realpath` canon so conversations
      // dsh web created under the vault's workspace stay visible even when
      // the two surfaces spell the same directory differently.
      const resolve = makeCanonicalResolver();
      const vaultCanon = await resolve(process.cwd());
      const mine = [];
      for (const r of all) {
        const cwd = r?.header?.cwd;
        if (typeof cwd !== "string" || cwd === "") continue;
        if (cwd !== process.cwd() && !(vaultCanon != null && (await resolve(cwd)) === vaultCanon)) continue;
        if (r.persisted !== true) continue;
        if (archived.has(String(r.header.id))) continue;
        mine.push(r);
      }
      const capped = mine.slice(0, 60);
      if (capped.length > 0) {
        // Public face on the mounted engine; folds the newest session/title per id.
        const titled = await sessionQuery.readTitleSnapshots(capped.map((r) => r.header.id));
        for (const row of titled) {
          if (row?.status !== "fulfilled") continue;
          const id = row.value.session.id;
          out.push({
            id,
            title: row.value.title?.title ?? "",
            updatedAt:
              toMillis(row.value.title?.updatedAt) ??
              toMillis(row.value.session.createdAt) ??
              0,
            live: handles.has(id) || mine.find((m) => m.header.id === id)?.live === true,
            running: isRunning(id),
          });
        }
      }
    }
    emit({
      t: "sessions",
      sessions: out,
      cwd: process.cwd(),
      ...(archivedId != null ? { archived: String(archivedId) } : {}),
    });
  }

  /**
   * The `/` picker's command section: the same `commands` registry dsh web
   * lists (`commands.list`), scoped to the live agent when one is up. No agent
   * is minted just to list — global commands still appear where available.
   * When the registry is absent (an older dsh base), `unsupported: true` lets
   * the plugin keep the composer's `/` pane open with a hint instead of a
   * broken empty list.
   */
  async function sendCommands() {
    const commands = ctx.get("commands");
    if (!commands || typeof commands.list !== "function") {
      emit({ t: "commands", commands: [], unsupported: true });
      return;
    }
    try {
      const agent = activeHandle()?.agent ?? null;
      const descriptors = commands.list(agent);
      emit({
        t: "commands",
        commands: descriptors.map((c) => ({
          name: c.name,
          description: c.description ?? "",
          input: c.input ?? null,
        })),
      });
    } catch (err) {
      emit({ t: "error", message: `list_commands failed: ${String(err?.message ?? err)}` });
    }
  }

  /**
   * The `/` picker's skill section: `skills.list` from the same layered
   * SkillRegistry dsh web renders. Flags ride through as-is so the plugin can
   * filter user-invocable skills at the UI boundary.
   */
  async function sendSkills() {
    const skills = ctx.get("skills");
    if (!skills || typeof skills.list !== "function") {
      emit({ t: "skills", skills: [], unsupported: true });
      return;
    }
    try {
      const agent = activeHandle()?.agent;
      const lookup = agent ? { scope: agent } : {};
      const summaries = await skills.list(lookup);
      emit({
        t: "skills",
        skills: summaries.map((s) => ({
          name: s.name,
          description: s.description ?? "",
          provider: s.provider ?? "",
          userInvocable: s.invocation?.userInvocable !== false,
        })),
      });
    } catch (err) {
      emit({ t: "error", message: `list_skills failed: ${String(err?.message ?? err)}` });
    }
  }

  /**
   * One local slash-command run, exactly dsh web's `commands.execute`: no
   * model round-trip, the handler's lifecycle lands in the session log
   * (`command/run` + `command/done`) and the settled result is surfaced as a
   * single `command_result` line. A session-less bridge mints its session
   * lazily here too — an executed command IS activity. `kind: "miss"` means
   * the line was not a recognized command (still useful as a skill gesture
   * downstream), `kind: "unsupported"` means this dsh base ships no registry.
   */
  async function executeCommandRaw(line) {
    const commands = ctx.get("commands");
    if (!commands || typeof commands.execute !== "function") {
      emit({ t: "command_result", id: null, name: "", kind: "unsupported", text: "commands service unavailable" });
      return;
    }
    // A command IS activity, so a session-less bridge mints one here too.
    const h = await ensureActive();
    const ac = new AbortController();
    const executed = await commands.execute(h.agent, line, [], ac.signal);
    const name = (line.split(/\s+/)[0] ?? "").replace(/^\//, "");
    if (!executed) {
      emit({ t: "command_result", session: activeId, id: null, name, kind: "miss" });
      return;
    }
    emit({
      t: "command_result",
      session: activeId,
      id: String(executed.commandId),
      name,
      kind: executed.result.kind,
      ...(executed.result.text !== undefined ? { text: executed.result.text } : {}),
    });
    // A command IS activity (it may even have minted the session), so its
    // record must be durable exactly like a prompt's — otherwise the listing
    // keeps filtering the session out as not-yet-persisted.
    void durableFlush().catch(() => {});
  }

  /**
   * Archive a session durably and resurface its listing. Mirror of dsh web:
   * the archived session leaves every grouping surface but its log and
   * workspace slot stay put (a future unarchive restores the position). When
   * the archived session is the one the bridge is live on, the selection is
   * dropped back to a New Session — exactly what web's projection does — so a
   * hidden session can never keep receiving prompts from this surface.
   */
  async function archiveSessionCmd(rawId) {
    const id = String(rawId ?? "");
    if (!id) throw new Error("archive_session: missing id");
    // Archiving hides the session from every surface, so unlike a plain switch
    // it DOES stop that session's work: a turn nobody can see must not keep
    // burning tokens. Cancel it (so the turn ends durably) and drop the agent.
    const pooled = handles.get(id);
    if (pooled) {
      try {
        pooled.agent.cancel({ kind: "user" });
        await pooled.agent.whenIdle();
      } catch {
        /* already settled */
      }
    }
    await archiveSession(id);
    disposeSession(id);
    if (id === activeId) {
      // dsh web parity: the sidebar falls back to a blank New Session, so a
      // hidden session can never keep receiving prompts from this surface.
      activeId = "";
    }
    await sendSessions(id);
  }

  async function openSession(id) {
    const wanted = String(id);
    if (opening) throw new Error("another session switch is already in progress");
    const selection = defaultModel.currentSelection();
    const model = `${selection.provider}/${selection.model}`;

    // Already pooled: re-select it and replay its IN-MEMORY log, which is
    // complete and includes a turn that is still streaming. No resume, no
    // interruption — this is what makes switching away and back lossless.
    const pooled = handles.get(wanted);
    if (pooled) {
      setActive(wanted);
      emit({
        t: "session_opened",
        id: wanted,
        model,
        running: isRunning(wanted),
        turns: foldHistory(pooled.agent.session?.events ?? []),
      });
      return;
    }

    opening = true;
    try {
      const { events } = await resumeInto(wanted);
      setActive(wanted);
      trimPool();
      emit({
        t: "session_opened",
        id: wanted,
        model,
        running: isRunning(wanted),
        turns: foldHistory(events),
      });
      noteSessionStatus(wanted);
    } finally {
      opening = false;
    }
  }

  /**
   * Bring one persisted session back as a pooled agent. Split out of
   * `openSession` so a prompt aimed at an evicted-but-still-selected session
   * can silently re-resume it instead of starting an unrelated new one.
   */
  async function resumeInto(id) {
    const wanted = SessionId(String(id));
    const selection = defaultModel.currentSelection();
    // Durable state first: a freshly exited writer may not have drained.
    await durableFlush().catch(() => {});
    let persistedEvents = [];
    try {
      persistedEvents =
        (await ctx.get("sessionPersistence")?.inspect?.(wanted))?.events ?? [];
    } catch {}
    let next;
    try {
      next = await agents.resume({
        resumeSessionId: wanted,
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, liveSelection);
        },
      });
    } catch (err) {
      if (!/already registered/i.test(String(err?.message ?? err))) throw err;
      const existing = agents.get(wanted);
      if (!existing) throw err;
      next = { agent: existing, dispose: void 0 }; // reuse the live registration
    }
    await next.agent.whenIdle();
    handles.set(String(id), next);
    if (persistedEvents.length === 0) {
      try {
        persistedEvents = next.agent.session?.events ?? [];
      } catch {}
    }
    return { handle: next, events: persistedEvents };
  }

  /**
   * The agent a prompt or command should go to. Lazily mints a session when
   * the sidebar sits on a blank New Session, and re-resumes one the pool has
   * evicted while it was still on screen.
   */
  async function ensureActive() {
    const h = activeHandle();
    if (h) return h;
    if (activeId !== "") return (await resumeInto(activeId)).handle;
    return startFresh();
  }

  /**
   * Detach the sidebar to a blank New Session. Deliberately touches nothing
   * else: a "new chat" click must not cancel work in progress (that is dsh
   * web's behavior and the whole point of the pool) and must not register an
   * empty conversation — the next real prompt does that lazily.
   */
  async function resetToNewChat() {
    activeId = "";
  }

  // The bridge boots WITHOUT a session: opening the sidebar or clicking
  // "new chat" must not register a fresh conversation in the shared session
  // store. The first prompt sent creates it.

  emit({
    t: "ready",
    model: `${defaultModel.currentSelection().provider}/${defaultModel.currentSelection().model}`,
    cwd: process.cwd(),
  });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let ops = 0; // in-flight async control operations (models/sessions/open)
  let quitting = false;

  /** Keep stdin-EOF shutdown waiting for an async control operation. */
  function track(op) {
    ops += 1;
    op.then(
      () => {},
      () => {},
    ).finally(() => {
      ops -= 1;
      if (quitting && ops === 0 && pending === 0) quitWhenIdle();
    });
    return op;
  }

  /**
   * Durably drain the persistence write-batch (graceful-exit safety net).
   * Failures are contained, never propagated: the coordinator rejects when it
   * was never initialized (e.g. EOF shutdown of a session-less bridge), and a
   * crash there would kill the process with the tail still unwritten — the
   * exact outcome this drain exists to prevent.
   */
  function durableFlush() {
    const contain = (err) => {
      console.error("[deepshian] durable flush failed:", String(err?.message ?? err));
      if (DEBUG) emit({ t: "dbg", type: "durable_flush_failed", data: String(err?.message ?? err) });
    };
    const backend = ctx.get("sessionPersistence");
    const coord = backend?.coordinator;
    try {
      if (coord && typeof coord.flush === "function") {
        return Promise.resolve(coord.flush()).catch(contain);
      }
    } catch (err) {
      contain(err);
    }
    try {
      if (backend && typeof backend.flush === "function") {
        return Promise.resolve(backend.flush()).catch(contain);
      }
    } catch (err) {
      contain(err);
    }
    return Promise.resolve();
  }

  /** Exit once no turn or control operation is in flight; stdin EOF must not kill running work. */
  function quitWhenIdle() {
    quitting = true;
    if (pending === 0 && ops === 0) {
      // Multi-stage async writers drain past the first barrier; flush twice with
      // short dwells so stdin-EOF shutdown cannot truncate the event tail.
      void durableFlush()
        .then(async () => {
          await new Promise((r) => setTimeout(r, 150));
          return durableFlush();
        })
        .then(async () => {
          await new Promise((r) => setTimeout(r, 120));
          disposeEventTap?.();
          process.exit(0);
        });
      return;
    }
    const timer = setInterval(() => {
      if ((pending === 0 && ops === 0) || !quitting) {
        clearInterval(timer);
        if (quitting && pending === 0 && ops === 0) {
          // Multi-stage async writers drain past the first barrier; flush twice with
      // short dwells so stdin-EOF shutdown cannot truncate the event tail.
      void durableFlush()
        .then(async () => {
          await new Promise((r) => setTimeout(r, 150));
          return durableFlush();
        })
        .then(async () => {
          await new Promise((r) => setTimeout(r, 120));
          disposeEventTap?.();
          process.exit(0);
        });
        }
      }
    }, 150);
  }

  rl.on("line", (raw) => {
    const line = (raw ?? "").trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      msg = { prompt: line };
    }

    if (typeof msg.cmd === "string") {
      switch (msg.cmd) {
        case "list_models":
          track(
            sendModels().catch((err) =>
              emit({ t: "error", message: `list_models failed: ${String(err?.message ?? err)}` }),
            ),
          );
          return;
        case "set_model":
          track(
            defaultModel
              .saveSelection({ provider: String(msg.provider ?? ""), model: String(msg.model ?? "") })
              .then(() => sendModels())
              .catch((err) =>
                emit({ t: "error", message: `set_model failed: ${String(err?.message ?? err)}` }),
              ),
          );
          return;
        case "list_sessions":
          track(
            sendSessions().catch((err) =>
              emit({ t: "error", message: `list_sessions failed: ${String(err?.message ?? err)}` }),
            ),
          );
          return;
        case "stop":
          // Abort one session's in-flight turn (default: the one on screen).
          // Only THAT session stops; everything else in the pool keeps running.
          track(
            Promise.resolve().then(() => {
              const id = String(msg.id ?? activeId);
              const h = id === "" ? null : handles.get(id);
              if (h?.agent) h.agent.cancel({ kind: "user" });
            }).catch((err) =>
              emit({ t: "error", message: `stop failed: ${String(err?.message ?? err)}` }),
            ),
          );
          return;
        case "new_chat":
          // Detach to a blank New Session. Nothing is cancelled and no agent
          // is disposed: sessions with a turn in flight keep streaming in the
          // background and stay reachable from the history list.
          track(
            resetToNewChat().catch((err) =>
              emit({ t: "error", message: `new_chat failed: ${String(err?.message ?? err)}` }),
            ),
          );
          return;
        case "open_session":
          track(
            openSession(msg.id).catch((err) =>
              emit({ t: "error", message: `open_session failed: ${String(err?.message ?? err)}` }),
            ),
          );
          return;
        case "archive_session":
          track(
            archiveSessionCmd(msg.id).catch((err) =>
              emit({ t: "error", message: `archive_session failed: ${String(err?.message ?? err)}` }),
            ),
          );
          return;
        case "list_commands":
          track(
            sendCommands().catch((err) =>
              emit({ t: "error", message: `list_commands failed: ${String(err?.message ?? err)}` }),
            ),
          );
          return;
        case "list_skills":
          track(
            sendSkills().catch((err) =>
              emit({ t: "error", message: `list_skills failed: ${String(err?.message ?? err)}` }),
            ),
          );
          return;
        case "execute_command": {
          const line = typeof msg.line === "string" ? msg.line.trim() : "";
          if (line === "" || !line.startsWith("/")) {
            emit({
              t: "command_result",
              id: null,
              name: "",
              kind: "miss",
              text: "execute_command: line must start with /",
            });
            return;
          }
          track(
            executeCommandRaw(line).catch((err) =>
              emit({ t: "error", message: `execute_command failed: ${String(err?.message ?? err)}` }),
            ),
          );
          return;
        }
        default:
          emit({ t: "error", message: `deepshian-bridge: unknown command "${msg.cmd}"` });
          return;
      }
    }

    const prompt = typeof msg.prompt === "string" ? msg.prompt : "";
    if (!prompt) return;
    const text = prompt;

    pending += 1;
    (async () => {
      // Lazy session creation / re-resume of an evicted session. A session is
      // minted only on the first real prompt, so "new chat"/sidebar opens
      // never register empty conversations in the shared session store.
      const h = await ensureActive();
      const sid = activeId;
      markTurnStart(sid);
      try {
        // Access mode as real, enforced policy events on the active session
        // (the same mechanism dsh web's /permission presets use, no prefixing).
        setSandboxMode(h.agent.session, msg.mode === "readonly" ? "read-only" : "workspace-write");
        setApprovalPolicy(h.agent.session, "ask");
        h.agent.followup(
          createUserMessage({
            content: [{ type: "text", text }],
            source: { kind: "user" },
          }),
        );
        await h.agent.whenIdle();
      } finally {
        markTurnEnd(sid);
      }
    })()
      .catch((err) => {
        emit({ t: "error", session: activeId, message: String(err?.message ?? err), stack: String(err?.stack ?? "") });
      })
      .finally(() => {
        pending -= 1;
        void durableFlush().catch(() => {});
        if (quitting && pending === 0 && ops === 0) quitWhenIdle();
      });
  });

  rl.on("close", () => {
    quitWhenIdle();
  });
}

/** Exported for tests: the pure workspace-registry adoption fold. */
export { adoptVaultWorkspace };

export function apply(ctx) {
  run(ctx).catch((err) => {
    emit({ t: "error", message: `deepshian-bridge failed: ${String(err?.message ?? err)}`, stack: String(err?.stack ?? "") });
    process.exit(1);
  });
}
