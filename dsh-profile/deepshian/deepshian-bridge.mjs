// DeepSeek Harness 闁?Obsidian bridge runner.
// A Cordis plugin (inserted by the `deepshian` profile's cordis.patch.yml) that
// drives the real dsh Agent core and exposes it as a tiny, stable JSONL protocol
// over stdio:
//
//   inbound (plugin 闁?dsh), one JSON object per line:
//     {"prompt":"...","mode":"writable"|"readonly"}
//     {"cmd":"list_models"}
//     {"cmd":"set_model","provider":"...","model":"..."}
//     {"cmd":"list_sessions"}
//     {"cmd":"open_session","id":"<sessionId>"}
//     {"cmd":"new_chat"}                    drop the live agent; next prompt mints a session
//     {"cmd":"archive_session","id":"<sessionId>"}   archive durably (the SAME global set dsh web maintains)
//
//   outbound (dsh 闁?plugin), one JSON object per line:
//     {"t":"ready","model":"...","cwd":"..."}   (boots WITHOUT a session)
//     {"t":"models","current":{"provider","model"},"models":[{provider,id,name}]}
//     {"t":"sessions","sessions":[{id,title,updatedAt,live}],"archived":"<id>"}
//         (deleted + archived excluded; `archived` echoes the id an archive_session answered)
//     {"t":"session_opened","id":"...","model":"...","turns":[{user,assistant,tools:[...]}]}
//     {"t":"session_created","id":"...","model":"..."}   lazy mint on the first prompt
//     {"t":"turn_start"} {"t":"turn_end",...} {"t":"error",...}
//     {"t":"text"/"reasoning"/"tool_use"/"tool_result"/"usage"} (same as before)
//
// Sessions persist through the shared `$DSH_HOME/sessions` JSONL backend, keyed
// by project directory, so every conversation driven here is the SAME durable
// record dsh web lists for this workspace 闁?open either surface against the
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
// empty conversation in the shared session store. The process keeps multi-turn
// memory inside one live Agent; switching to an older session resumes it
// through `agents.resume` (same log, full context), disposes the previously
// live agent, and replays its persisted events back to the sidebar as compact
// `turns`.

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

/** Map one streaming session event onto the flat JSONL protocol. */
function mapEvent(event) {
  const d = event.data;
  switch (event.type) {
    case "turn/start":
      emit({ t: "turn_start" });
      break;
    case "assistant/chunk": {
      const c = d?.chunk;
      if (c == null) break;
      if (c.type === "text-delta") emit({ t: "text", delta: c.text ?? "" });
      else if (c.type === "reasoning-delta") emit({ t: "reasoning", delta: c.text ?? "" });
      else if (c.type === "usage") emit({ t: "usage", usage: c.usage });
      break;
    }
    case "tool/call":
      // Dedicated start-marker per tool invocation; arguments is a JSON string.
      emit({
        t: "tool_use",
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

  /** One wire-up of the JSONL mapper scoped to the currently active session. */
  let activeSessionId = "";
  const disposeEventTap = ctx.on("session/event", (session, event) => {
    if (session?.id !== activeSessionId) return;
    const noisy =
      event.type === "assistant/chunk" &&
      ["text-delta", "reasoning-delta", "usage"].includes(event.data?.chunk?.type);
    if (DEBUG && !noisy) {
      emit({ t: "dbg", type: event.type, seq: event.seq, data: event.data });
    }
    try {
      mapEvent(event);
    } catch (err) {
      emit({ t: "error", message: `event map failed: ${String(err)}`, stack: String(err?.stack ?? "") });
    }
  });

  let handle = null; // { agent, dispose } for the live agent
  let opening = false; // session switch in flight

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
    setActive(h, String(sessionId));
    emit({
      t: "session_created",
      id: String(sessionId),
      model: `${selection.provider}/${selection.model}`,
    });
    return h;
  }

  function setActive(next, sessionId) {
    const prev = handle;
    handle = next;
    activeSessionId = String(sessionId);
    if (prev && prev !== next) {
      try {
        prev.dispose?.();
      } catch {
        /* prior agent already gone */
      }
    }
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
          out.push({
            id: row.value.session.id,
            title: row.value.title?.title ?? "",
            updatedAt:
              toMillis(row.value.title?.updatedAt) ??
              toMillis(row.value.session.createdAt) ??
              0,
            live: mine.find((m) => m.header.id === row.value.session.id)?.live === true,
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
    if (id === activeSessionId && pending > 0) {
      throw new Error("a turn is still running; wait for it to finish");
    }
    await archiveSession(id);
    if (id === activeSessionId) {
      // Archiving must not leave a live agent writing into a hidden session.
      await resetToNewChat();
    }
    await sendSessions(id);
  }

  async function openSession(id) {
    const wanted = SessionId(String(id));
    if (opening) throw new Error("another session switch is already in progress");
    if (pending > 0) throw new Error("a turn is still running; wait for it to finish");
    const selection = defaultModel.currentSelection();

    // Already active: reply immediately, folding the current session from disk.
    if (activeSessionId === String(id)) {
      let recs = [];
      try {
        recs = (await ctx.get("sessionPersistence")?.inspect?.(wanted))?.events ?? [];
      } catch {}
      emit({
        t: "session_opened",
        id: activeSessionId,
        model: `${selection.provider}/${selection.model}`,
        turns: foldHistory(recs),
      });
      return;
    }
    if (handle && handle.agent?.status !== "idle") throw new Error("the agent is busy");
    opening = true;
    try {
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
      if (persistedEvents.length === 0) {
        try {
          persistedEvents = next.agent.session?.events ?? [];
        } catch {}
      }
      setActive(next, String(id));
      emit({
        t: "session_opened",
        id: activeSessionId,
        model: `${selection.provider}/${selection.model}`,
        turns: foldHistory(persistedEvents),
      });
    } finally {
      opening = false;
    }
  }

  /**
   * Drop the live agent without minting a new session. A "new chat" click
   * (or the sidebar simply reopening) never creates an empty persisted record;
   * the next real prompt lazily creates the session via `startFresh`.
   * A running turn is cancelled and awaited first so its `turn_end` still
   * reaches the sidebar (status returns to ready); `pending` is deliberately
   * left alone — the turn's own `.finally` decrements it when `whenIdle`
   * settles.
   */
  async function resetToNewChat() {
    const h = handle;
    if (h) {
      if (pending > 0 && h.agent) {
        try {
          h.agent.cancel({ kind: "user" });
        } catch {
          /* agent already settled */
        }
        try {
          await h.agent.whenIdle();
        } catch {
          /* agent disposed mid-settle; nothing left to wait for */
        }
      }
      try {
        h.dispose?.();
      } catch {
        /* prior agent already gone */
      }
    }
    handle = null;
    activeSessionId = "";
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
  let pending = 0;
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

  /** Durably drain the persistence write-batch (graceful-exit safety net). */
  function durableFlush() {
    const backend = ctx.get("sessionPersistence");
    const coord = backend?.coordinator;
    try {
      if (coord && typeof coord.flush === "function") return Promise.resolve(coord.flush());
    } catch {
      /* fall through */
    }
    try {
      if (backend && typeof backend.flush === "function") return Promise.resolve(backend.flush());
    } catch {
      /* nothing flushable mounted */
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
          // Abort the in-flight turn. The agent converges to idle; `whenIdle`
          // resolves, `pending` drains, and a `turn_end` (reason: canceled) follows.
          track(
            Promise.resolve().then(() => {
              if (pending > 0 && handle?.agent) handle.agent.cancel({ kind: "user" });
            }).catch((err) =>
              emit({ t: "error", message: `stop failed: ${String(err?.message ?? err)}` }),
            ),
          );
          return;
        case "new_chat":
          // Reset to a fresh, session-less state: dispose the live agent without
          // minting a new session record (created lazily on the next prompt).
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
      // Lazy session creation: a session-less bridge mints its first session
      // only when a real prompt is sent, so "new chat"/sidebar opens never
      // register empty conversations in the shared session store.
      if (!handle) await startFresh();
      // Access mode as real, enforced policy events on the active session (the
      // same mechanism dsh web's /permission presets use, no prompt prefixing).
      setSandboxMode(handle.agent.session, msg.mode === "readonly" ? "read-only" : "workspace-write");
      setApprovalPolicy(handle.agent.session, "ask");
      handle.agent.followup(
        createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "user" },
        }),
      );
      await handle.agent.whenIdle();
    })()
      .catch((err) => {
        emit({ t: "error", message: String(err?.message ?? err), stack: String(err?.stack ?? "") });
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
