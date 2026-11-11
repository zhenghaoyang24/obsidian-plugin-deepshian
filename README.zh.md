# DeepShian

**在 Obsidian 侧栏使用 DeepSeek Harness，直接围绕笔记提问、整理和编辑。**

[English](README.md) · 简体中文

[原项目](https://github.com/zhenghaoyang24/obsidian-plugin-deepshian) · [修复分支](https://github.com/mzh-nuist/obsidian-plugin-deepshian/tree/codex/fix-harness-output) · [原项目问题反馈](https://github.com/zhenghaoyang24/obsidian-plugin-deepshian/issues)

> **这个分支是什么？** 这是针对 DeepShian 1.3.0 的兼容修复，解决新版 Harness 下没有回答、思考混入正文和历史会话空白等问题。原项目的 1.3.0 发布包不包含这些修复。本分支尚未发布新的版本标签，插件清单中的版本号仍为 `1.3.0`。

## 修复了什么

| 原来的表现 | 修复后的表现 |
| --- | --- |
| 任务结束了，工具卡片也有，但看不到回答。 | 接入新版实时输出通道，并从完整消息中补回遗漏正文。 |
| 补发完整消息时，可能把思考内容当成答案。 | 只提取正文块，思考走独立通道。 |
| 实时文字和完整回答都到达时，答案可能重复。 | 只补齐尚未显示的尾部文字。 |
| 打开旧会话只有标题，内容为空。 | 使用新版会话快照接口，同时兼容旧版事件数组。 |
| Think 折叠区和预览文字干扰阅读。 | 默认隐藏，随时可以打开“显示思考过程”。 |

原项目的 [issue #1](https://github.com/zhenghaoyang24/obsidian-plugin-deepshian/issues/1) 也报告了“工具有显示，回答不显示”的现象。

## 能做什么

- 在 Obsidian 内围绕笔记提问。
- 输入 `@`，选择要引用的文件或文件夹。
- 用“仅查看”阅读资料，用“工作区写入”执行明确的编辑任务。
- 查看流式回答和工具调用卡片，自行决定是否显示 Think 区。
- 选择当前 DSH 安装中可用的模型。
- 打开和管理与 dsh web 共用存储的会话。
- 使用中文或英文界面。

## 使用条件

| 组件 | 要求 |
| --- | --- |
| Obsidian | 仅桌面端。插件声明最低版本为 1.5.7；本次界面实测使用 Windows 上的 1.15.0。 |
| DeepSeek Harness | 已有可用的 DSH 启动器，并在 DSH 中配置好模型访问。本次桥接修复实测使用 0.2.2-rc.1。 |
| 构建工具 | 从本分支构建需要 Git、npm，以及 Node.js 22 LTS 或受支持的更新 LTS。仓库发布流程使用 Node.js 22。 |

DSH 桌面安装包可能自带运行时，以所用 DSH 发行版的要求为准。不一定要全局安装 `dsh`：在插件中填写现有启动器的完整路径也可以。

## 安装这个修复分支

### 1. 构建插件

```bash
git clone --branch codex/fix-harness-output --single-branch https://github.com/mzh-nuist/obsidian-plugin-deepshian.git
cd obsidian-plugin-deepshian
npm ci
npm test
npm run build
```

`npm run build` 会运行 lint 和类型检查，再生成三个安装文件：

```text
build/
├── main.js
├── manifest.json
└── styles.css
```

**GitHub 的 Download ZIP 下载的是源码，不是可以直接安装的插件包。** 重新安装社区商店版，或重新下载原项目的 1.3.0，也不会获得本分支的修复。

### 2. 复制到你的 Obsidian 仓库

先在 Obsidian 中暂时停用 DeepShian。如果已经安装过，备份原有的三个插件文件，再把 `build/` 中的三个文件复制到：

```text
<你的 Obsidian 仓库>/.obsidian/plugins/deepshian/
```

保留已有的 `data.json`，其中存放插件设置。无需把笔记、会话日志或 DSH 凭据复制到本 GitHub 仓库。

### 3. 连接 DSH

1. 在 **设置 → 第三方插件** 中启用 DeepShian。
2. 打开 **设置 → DeepShian**。如果 `dsh` 已在 PATH 中，保留默认“dsh 命令”；否则填写现有启动器的完整路径。
3. 首次使用时，按提示安装桥接 profile。已存在但内容不匹配的桥接 profile 会由插件刷新。
4. 点击左侧工具栏的机器人图标，打开 **DSH 对话**。
5. 发送：`请只回复 PING_OK，不要读取文件，不要调用工具。`

看到回答 `PING_OK` 才说明整条链路可用。仅显示“就绪 / Ready”，只代表桥接进程已启动。

## 使用 Command Code GOAT 额度

Command Code 的 [Provider API](https://commandcode.ai/docs/provider) 支持 GOAT 账号，按套餐内对应模型的访问权限和额度计算用量。使用者需要自己的 Command Code 账号和 API key，安装本 fork 不会附送订阅或共享额度。

DeepShian 使用独立的 DSH profile，通常叫 `deepshian`。桌面版或网页版 profile 已经配置好的服务商，不会自动出现在这份独立配置中。

1. 先按上文步骤初始化 DeepShian。
2. 通过 DSH 的凭据管理功能提供 `COMMANDCODE_API_KEY` 引用。如果其他 DSH profile 已在使用这个共享引用，直接复用即可；不要把密钥本身写进 YAML 或本仓库。
3. 备份 `$DSH_HOME/profiles/deepshian/cordis.patch.yml`，默认位置是 `~/.dsh/profiles/deepshian/cordis.patch.yml`。将[示例配置](examples/commandcode-goat.patch.yml)的条目合并进去，保留原有 `deepshian-bridge` 插入条目。若已有 `llm-pi-ai` 或 `agent-default-model`，合并现有条目，避免重复 id，并保留其他服务商配置。
4. 等当前任务结束后，停用再启用 DeepShian。新建会话，在模型菜单的 **commandcode** 分组中选择 **DeepSeek V4.1 Flash Fast**。
5. 发送 `请只回复 GOAT_OK，不要读取文件，不要调用工具。`，确认能看到回答。

示例使用 `https://api.commandcode.ai/provider/v1` 的 OpenAI Chat Completions 接口，声明两个纯文本模型选项，默认模型为 `deepseek/deepseek-v4.1-flash-fast`。可在模型菜单中切换 Command Code 通道和 `deepseek-account`；后者对应 DeepSeek 登录账号通道。可用模型与额度以你的服务商账号为准，不能只看插件显示的模型短名称。

上述通道和模型已经做过真实桥接请求及 Obsidian 回答检查。示例文件本身做了结构检查，没有测试图片输入或其他 Command Code 模型。重新安装或刷新桥接 profile 可能覆盖手动配置，请保留服务商配置备份。仅修改 YAML 不会让已运行的桥接立即切换所选模型，需要重新加载。

DSH 适配器及凭据引用格式见[官方 pi-ai 适配器文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md)。

## 日常怎么用

只想阅读、提问时，先选择“仅查看”。例如输入 `@`，选中一篇笔记，再发送：

> 请用三点总结这篇笔记，不要修改任何文件。

需要编辑时，再切换“工作区写入”，给出具体任务。Agent 会按 Harness 的权限策略使用工具、修改实际文件。Enter 发送，Shift+Enter 换行；输入 `/` 查看可用命令和技能。

同一会话尽量只在一个界面继续：避免同时从 DeepShian 和 dsh web 向它发送任务。

## 设置说明

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| 插件语言 | 自动 | 跟随 Obsidian，或固定为中文 / English。 |
| dsh 命令 | `dsh` | 已安装 DSH 的启动命令或完整路径。 |
| 桥接 profile | `deepshian` | 传给启动器的 profile 名称。 |
| 重新安装桥接 profile | 手动操作 | 恢复内置桥接文件和本机路径；如自行修改过 profile，请先备份。 |
| 显示思考过程 | 关闭 | 显示独立 Think 折叠区和预览。关闭只影响展示，不改变模型的思考参数。 |
| 默认只读启动 | 关闭 | 开启后，新侧栏默认进入“仅查看”；未开启时默认为“工作区写入”。 |
| 打开时 | 开始新对话 | 可改为恢复这个 Obsidian 仓库最近的会话。 |
| 调试日志 | 关闭 | 把 Harness 错误输出和未解析内容输出到 Obsidian 开发者控制台，供排查问题。 |

## 常见问题

| 现象 | 先检查什么 |
| --- | --- |
| 有工具卡片，还是没有答案 | 确认 `main.js` 来自本分支的构建。版本号同为 1.3.0，不能仅靠它区分修复版和原版。复制后停用再启用插件。 |
| DSH 启动不了 | 检查启动器路径，并确认同一套 DSH 单独使用时可以正常工作。 |
| 提示登录、额度或模型错误 | 到 DSH 中检查所选模型服务商；插件不会替代其账号和服务要求。 |
| 仍看到大段思考 | 关闭“显示思考过程”；如果思考混在答案正文里，检查是否仍在使用旧桥接或旧构建。 |
| 历史会话空白 | 使用修复后的桥接，再重新打开会话，无需删除底层记录。 |
| 更新后修复失效 | 社区商店更新可能覆盖安装文件。重新构建修复分支，或先检查新版原项目是否已经包含修复。 |

## 数据会去哪里

插件启动的是**本机 DSH 进程**，但模型和相关服务由你的 Harness 配置决定。它不保证离线推理，也不保证所有数据都留在本机：提示词、选中的笔记上下文和日志可能由 DSH 中配置的模型服务商或其他服务处理。发送私密资料前，请核对这些配置。

“工作区写入”可以修改真实文件。“显示思考过程”只影响显示，不改变文件权限、模型思考能力或服务用量。

## 验证和开发

```bash
npm ci
npm test
npm run build
npm run dev
```

本分支已通过 **30 项测试**，以及 lint、TypeScript 类型检查和生产构建。兼容测试执行实际桥接模块，使用模拟事件和不执行操作的 SDK 导入，不调用模型、不读取真实笔记。覆盖完整消息补发、思考过滤、流式去重、尾部补齐、并发会话隔离、新实时事件路由和历史回放。

底层桥接修复还在 Windows 的 Obsidian 1.15.0、Harness 0.2.2-rc.1 中做过实际检查：能显示测试回答，也能恢复旧会话的正式答案。本次没有对其他平台和 Harness 版本做人工验收。

## 作者与协议

DeepShian 由 [zhenghaoyang24](https://github.com/zhenghaoyang24) 创建。本次兼容修复维护于 [mzh-nuist 的 fork](https://github.com/mzh-nuist/obsidian-plugin-deepshian)。

遵循 [MIT 协议](LICENSE)，保留原作者版权与署名。
