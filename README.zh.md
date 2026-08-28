<p align="center">
  <span style="font-size: 2em; font-weight: bold;"><span style="color: white;">Deep</span><span style="color: #7c3aed;">Shian</span></span>
</p>

<img width="1858" height="1014" alt="image" src="https://github.com/user-attachments/assets/928c02f6-25c5-487b-a105-0cf65391ebfc" style="width: 100%; height: auto; display: block;" />

[English](README.md) | 简体中文

![DSH](<https://img.shields.io/badge/Powered%20by-DeepSeek%20Harness-6366f1?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0tMiAxNS41di03bDUgMy41LTUgMy41eiIvPjwvc3ZnPg==>)
![Version](https://img.shields.io/badge/version-0.2.0-22c55e?style=flat-square)
![Obsidian](<https://img.shields.io/badge/Obsidian-Desktop%20Only-7c3aed?style=flat-square&logo=obsidian&logoColor=white>)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=flat-square&logo=typescript&logoColor=white)

DeepShian 把 DeepSeek Harness 直接带进 Obsidian 右侧栏。后端不是云端 API，而是你本机已经装好的 `dsh`，因此侧边栏里就是完整 Agent 体验——流式回答、思考过程、工具调用卡片——并且可以直接读写 vault 文件。

## 功能

### 🔒 完全本地运行

- 全部在本机完成：无云端 API、无需账号，vault 内容不出本机。
- 侧边栏内就是完整 Agent：回答、工具调用、文件操作都由本机 `dsh` 驱动。

### ✨ 模型选择

- 一键列出本机 `dsh` 可用的全部模型；多 provider 时分组展示。
- 选择会一直记住：新会话、重启、dsh web 都读到同一个选择。

### 🔐 权限控制

- 输入框旁选择访问模式：**Read Only**（仅查看、检索，不做修改）或 **Workspace Write**（可写入文件并执行命令）。
- 模式是真实强制的，不是提示词约束——由你决定 Agent 能碰什么。

### 💬 会话管理

- 顶部实时显示当前会话标题；📋 **历史会话** 按钮展开面板，列出本工作区保存的会话。
- 点击任意历史会话即恢复完整上下文（含工具调用）。
- 会话历史与 dsh web 共享：两侧看到同一份。
- **新会话** 一键重启，开启全新对话。

### 🎨 对话体验

- 流式回答逐字上屏；💭 思考过程可折叠；工具调用以卡片展示 input/output 与状态；回合结束显示 token 用量。
- 生成中发送按钮变为 **Stop**，点击即中断当前回合。
- 界面自动中英文切换，跟随 Obsidian 语言设置。

## 环境要求

| 依赖                       | 版本     | 说明                           |
| -------------------------- | -------- | ------------------------------ |
| **Obsidian**         | ≥ 1.4.0 | 仅支持桌面端（Desktop Only）   |
| **Node.js**          | ≥ 18    | 提供 `dsh` 命令的运行环境      |
| **DeepSeek Harness** | /        | 全局安装，确保 `dsh` 命令可用  |

```bash
# 验证 dsh 是否已安装
dsh --version
```

## 快速开始

### 1 安装到 Obsidian

**方式 A：插件商店搜索安装**

打开 Obsidian → **设置 → 第三方插件 → 浏览** → 搜索 **deepshian** → **安装** → **启用**，然后点左侧栏 🤖 图标打开聊天。

**方式 B：从 Release 下载**

到 [Releases 页面](https://github.com/zhenghaoyang24/obsidian-plugin-deepshian/releases) 下载最新版本的三个文件`main.js`、`manifest.json`、`styles.css`。把它们放到 vault 的插件目录 `<vault>/.obsidian/plugins/deepshian/`。然后：**设置 → 第三方插件 → 启用 DeepShian** → 点左侧栏 🤖 图标打开聊天。

### 2 从源码构建（可选）

```bash
npm install
npm run build
```

构建产物在 `build/`——同样是这三个文件（`main.js`、`manifest.json`、`styles.css`），复制到 vault 的插件目录即可。

### 3 插件设置

| 设置                      | 默认值       | 说明                                             |
| ------------------------- | ------------ | ------------------------------------------------ |
| **dsh command**     | `dsh`      | PATH 找不到时可填全路径                          |
| **Bridge profile**  | `deepshian` | 携带 JSONL 桥接插件的 profile 名称（首次运行自动安装） |
| **Start read-only** | 关           | 新会话默认以只读模式打开                         |
| **Debug logging**   | 关           | 未解析的 stdout 行与 harness stderr 输出到控制台 |
