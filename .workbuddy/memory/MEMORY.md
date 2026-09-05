# DeepShian — 项目长期记忆

Obsidian 插件（id `deepshian`）：把本机 DeepSeek Harness（`dsh` CLI）接到 Obsidian 右侧边栏，全本地、无云端 API。

## 架构总览

- `src/main.ts` — 插件入口 `DshBridgePlugin`：设置、命令、ribbon、profile 安装门禁、view 绑定。
- `src/bridge/` — `DshBridge` 常驻 `dsh --profile deepshian` 子进程，stdio 双向 JSONL；`types.ts` 是协议唯一真源。**bridge 是 agent 池**（v1.3 起）：`Map<sessionId, handle>`，`MAX_LIVE_AGENTS=5` LRU 只淘汰 idle；`new_chat` 只 detach 不 cancel；`stop` 可带 session id；`activeId` 只表示"UI 在看哪个"。
- `src/chat/view.ts` — `DshChatView`（VIEW_TYPE `dsh-chat-view`），持有会话状态（activeSessionId / sessionsCache / runningIds / pendingResume），把 DOM 分给 `ChatHeader` / `ChatConversation` / `ChatComposer`。事件按 `eventSession()` 路由，非当前会话的流被丢弃（bridge 活日志兜底，切回时 `session_opened` 重放 + `resumeStreaming()` 接续流式）。isBusy/effectiveStatus 只看**当前会话**，后台会话运行不锁输入框。
- `dsh-profile/deepshian/deepshian-bridge.mjs`（1113 行）— dsh 侧 Cordis insert，驱动真实 Agent core，实现 models / sessions / commands / skills / archive 等控制指令。`src/profile/install.ts` 用 `?raw` 导入它，运行时按本机路径生成 `cordis.patch.yml` 写入 `$DSH_HOME/profiles/<name>`。
- `scripts/build.mjs` — lint + tsc + esbuild 打包到 `build/`（main.js + manifest.json + styles.css），`?raw` 资源走 text loader。

## dsh 原生能力（已核实，dsh 0.1.1-rc.2 源码在 /e/nodejs/node_global/node_modules/@deepseek-ai/dsh/node_modules/）

- `@deepseek-ai/dsh-agent` 的 `AgentRegistry` 是 `Map<sessionId, entry>`，**多 agent 并发是原生一等能力**：`create()` / `resume({resumeSessionId})` / `get(id)` / `list()`；重复注册同 id 才抛 `already registered`（bridge 里已有兜底分支）。子 agent 与父 agent 同进程并发也印证这点。
- `agent.status` 返回 `"idle" | "running"`；状态跃迁时经 agent 作用域派发 `agent/status` 事件（payload 含 `agent`），根 ctx 用 `ctx.on("agent/status", ...)` 能收到全部 agent。
- `agent.followup(input)` = `send(input, "next-turn", true)` → 写进持久化 Inbox 并唤醒 driver，**运行中发消息不会打断当前 turn**，排队等下一个 turn 边界。`agent.cancel(cause)` 默认**会清空 inbox**，要保留需传 `{ keepInbox: true }`。
- `session/event` 由 dsh-session 以 session 作用域发射，第一个参数带 `session`；根 ctx 一个监听器可观察所有会话 —— bridge 里 `if (session?.id !== activeSessionId) return` 是我们自己加的单例过滤。
- `sessionQuery.listSessions()` 行自带 `live`（= 本进程内有存活 session 对象），是"谁在跑"的现成底料。
- `agent/status` **不会**被转发给 web 客户端，说明"运行中"状态是 UI 侧聚合出来的，不是原生服务。
- 审批：dsh-base 挂载 `approval` 服务（策略默认 ask）。bridge 现已注册根级 `approval/request` answerer（签名 `(req, next)`，模仿 dsh-host-apiproxy）：池内会话的提权请求 → `approval_request` 事件 → UI 审批卡 → `approval_decision` 命令回传；abort（取消/停止/归档）自动 settle 为 `cancelled`；非池 agent（subagent）走 `next()` 保持 fail-closed。`unavailable` 的语义是 fail closed，绝不能让池内会话的审批落回默认分支。
- 审批：`setApprovalPolicy(session, "ask")` 在没有 answerer 的 CLI 进程里**fail closed**（waterfall 默认返回 `unavailable`，只有 `allowed-once` 才放行）。要暴露审批需注册作用域 `scopeTarget(agent, agent)` 的 `approval/request` waterfall answerer。

## 约定与坑（务必遵守）

- i18n：所有面向用户的字符串写成 `t(中文, 英文)`，运行期按当前 locale 取值；切换语言只需重渲染（view 走 `relocalize()`，设置页 `display()` 重画）。不要写死文案。
- 计时器一律用 `window.setTimeout/setInterval`（Obsidian 环境）。
- 会话是**懒创建**的：开侧栏/点新对话都不落盘，第一条真实 prompt 才 `startFresh()` mint 会话。改动会话逻辑别破坏这条。
- 会话与 dsh web 共享 `$DSH_HOME/sessions` + `storages/workspace.json`，用 `fs.realpath` 规范化 cwd 做跨端匹配；归档双向同步。
- Windows：子进程经 shell 启动，停止时用 `taskkill /T /F` 杀整棵树，否则 node 进程变孤儿。
- 协议事件新增要同时改三处：`src/bridge/types.ts`、`src/chat/view.ts handleEvent`、`deepshian-bridge.mjs`。turn 级事件都带 `session` 字段；会话运行态走 `session_status` 推送 + `sessions` 行内 `running`，来源是 prompt 生命周期计数（`pendingBySession`）+ `agent.status` 兜底，**不是** turn 事件计数。
- `patchPathHealthy()` 会比对已安装 bridge 文件与 bundle 内嵌源码的内容——插件更新后首次加载会静默重装 profile，别把这个检查改弱。
- `durableFlush()` 必须吞掉 rejection：dsh 的 PersistenceCoordinator 在未初始化（无会话）时 flush 会 reject，直接炸进程。
- bridge 事件 tap 按 `handles.has(sid)` 过滤——**必须保留**，否则子 agent（subagent 有自己的 session id）的事件会漏进协议。
- 归档会话 = 停掉它的 turn + dispose agent（隐藏的会话不能继续烧 token）；`agent.cancel()` 默认清空 inbox，要保留传 `{keepInbox:true}`。
- 当前版本 1.2.0；`minAppVersion 1.5.7` → 不能用 `revealLeaf()`（需 1.7.2），用 `setActiveLeaf()`。

## 质量门禁

`npm run build`（lint → typecheck → bundle）、`npm run dev`（watch）、`npm test`（vitest，tests/ 三份：bridge / chat-utils / profile-install）。
