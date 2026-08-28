<p align="center">
  <span style="font-size: 2em; font-weight: bold;"><span style="color: white;">Deep</span><span style="color: #7c3aed;">Shian</span></span>
</p>

<img width="1858" height="1014" alt="image" src="https://github.com/user-attachments/assets/928c02f6-25c5-487b-a105-0cf65391ebfc" style="width: 100%; height: auto; display: block;" />

[English](README.md) | 简体中文

![DSH](<https://img.shields.io/badge/Powered%20by-DeepSeek%20Harness-6366f1?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0tMiAxNS41di03bDUgMy41LTUgMy41eiIvPjwvc3ZnPg==>)
![Version](https://img.shields.io/badge/version-1.0.0-22c55e?style=flat-square)
![Obsidian](<https://img.shields.io/badge/Obsidian-Desktop%20Only-7c3aed?style=flat-square&logo=obsidian&logoColor=white>)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=flat-square&logo=typescript&logoColor=white)

DeepShian 把 DeepSeek Harness 直接带进 Obsidian 右侧栏。后端不是云端 API，而是你本机已经装好的 `dsh`，因此侧边栏里就是完整 Agent 体验——流式回答、思考过程、工具调用卡片——并且可以直接读写 vault 文件。

## 功能

- 🔒本地运行：回答、工具调用、文件操作都由本机 `dsh` 驱动。
- ✨模型选择：可以像 dsh web 哪样选择任意模型。
- 💬会话同步：DeepShian 工作空间与 dsh web 同步，包括会话记录，归档与删除。
- 🔐权限控制：可以像 dsh web 那样选择 Agent 的操作权限，**Read Only** 或 **Workspace Write**。
- 🎨对话体验：与 dsh web 一样的对话体验，包括流式输出、思考过程、工具调用等。
- 🌐多语言：界面完全双语（中文 / English），并跟随你的 Obsidian 语言。

## 环境要求

| 依赖                       | 版本     | 说明                           |
| -------------------------- | -------- | ------------------------------ |
| **Obsidian**         | ≥ 1.5.7 | 仅支持桌面端（Desktop Only）   |
| **Node.js**          | ≥ 18    | 提供`dsh` 命令的运行环境     |
| **DeepSeek Harness** | /        | 全局安装，确保`dsh` 命令可用 |

```bash
# 验证 dsh 是否已安装
dsh --version
```

## 快速开始

### 1 安装到 Obsidian

**方式 A：插件商店搜索安装**

在 Obsidian 中打开 **设置 → 第三方插件 → 浏览**，搜索 **deepshian** → **安装** → **启用**，然后点左侧栏 🤖 图标打开聊天。

**方式 B：从 Release 下载**

到 [Releases 页面](https://github.com/zhenghaoyang24/obsidian-plugin-deepshian/releases) 下载最新版本的三个文件 `main.js`、`manifest.json`、`styles.css`。把它们放到 vault 的插件目录 `<vault>/.obsidian/plugins/deepshian/`。然后：**设置 → 第三方插件 → 启用 DeepShian** → 点左侧栏 🤖 图标打开聊天。

### 2 从源码构建

```bash
npm install
npm run build     # 类型检查并打包到 build/（main.js + manifest.json + styles.css）
npm run dev       # 可选：监听模式增量构建
```

构建产物在 `build/`——同样是这三个文件（`main.js`、`manifest.json`、`styles.css`），复制到 vault 的插件目录即可。

### 3 插件设置

| 设置                     | 默认值       | 说明                                                                             |
| ------------------------ | ------------ | -------------------------------------------------------------------------------- |
| **插件语言**       | 自动         | 界面（含本设置页）显示语言：自动跟随 Obsidian——zh 显示中文，其他显示英文——或固定中文 / English |
| **dsh 命令**        | `dsh`        | 若 `dsh` 不在 PATH 中，填写完整路径                                          |
| **桥接 profile**    | `deepshian`  | 传给 `--profile` 的 profile 名称；首次运行自动安装                           |
| **重新安装桥接 profile** | —            | 首次运行自动安装（弹窗确认），或修复本机 profile 路径（例如 dsh 在插件之后才安装时） |
| **默认只读启动**     | 关闭         | 每个新侧边栏都以只读模式启动                                                     |
| **打开时**           | 开始新对话   | 打开侧边栏时是开始新对话，还是恢复本工作区最近一次会话                           |
| **调试日志**         | 关闭         | 将未解析的 stdout 行与 harness stderr 输出到开发者控制台                       |

## 开源协议

本项目基于 [MIT 协议](LICENSE) 开源。

## 贡献

欢迎提交 Issue 与 Pull Request。
