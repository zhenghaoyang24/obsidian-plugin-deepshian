# DeepShian

<img width="1858" height="1014" alt="image" src="https://github.com/user-attachments/assets/004b3af4-4b5b-4f6f-b920-cda4e7835df0" />

English | [简体中文](README.zh.md)

> Sidebar AI for Obsidian, powered by a local DeepSeek Harness

![DSH](<https://img.shields.io/badge/Powered%20by-DeepSeek%20Harness-6366f1?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0tMiAxNS41di03bDUgMy41LTUgMy41eiIvPjwvc3ZnPg==>)
![Version](https://img.shields.io/badge/version-0.2.0-22c55e?style=flat-square)
![Obsidian](<https://img.shields.io/badge/Obsidian-Desktop%20Only-7c3aed?style=flat-square&logo=obsidian&logoColor=white>)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=flat-square&logo=typescript&logoColor=white)

DeepShian brings DeepSeek Harness into Obsidian's right sidebar. There is no cloud API: it talks to the `dsh` already installed on your machine, so you get the full agent experience — streaming answers, thinking steps, tool-call cards — and it can read and edit your vault files directly.

## Features

### 🔒 Fully Local

- Runs entirely on your machine: no cloud API, no account, and no vault data leaves your device.
- The sidebar hosts the full agent — answers, tool calls, and file operations are all driven by your local `dsh`.

### ✨ Model Picker

- One click lists every model available in your local `dsh` setup; providers are grouped when you have several.
- Your choice sticks across new conversations, restarts, and the dsh web app.

### 🔐 Access Control

- Pick an access mode next to the input box: **Read Only** (view and search only) or **Workspace Write** (edit files and run commands).
- The mode is enforced for real — not a prompt hint — so you always decide what the agent may touch.

### 💬 Conversations

- The current conversation title is always shown; the 📋 **History** button opens a panel with every conversation saved in this workspace.
- Click a past conversation to resume it with full context, tool calls included.
- History is shared with the dsh web app — both sides see the same conversations.
- **New conversation** restarts the agent for a fresh start.

### 🎨 Chat Experience

- Streamed replies render word by word; 💭 thinking steps are collapsible; tool calls appear as cards with input/output and status; token usage is shown at the end of every turn.
- The send button turns into **Stop** while generating — click it to interrupt the current turn.
- The UI follows Obsidian's language setting (English / 简体中文).

## Requirements

| Dependency            | Version   | Notes                                          |
| --------------------- | --------- | ---------------------------------------------- |
| **Obsidian**    | ≥ 1.4.0  | Desktop only                                   |
| **Node.js**     | ≥ 18     | Runtime for the `dsh` command                  |
| **DeepSeek Harness** | /         | Installed globally so that `dsh` is available  |

```bash
# Verify dsh is installed
dsh --version
```

## Quick Start

### 1 Install the dsh profile

**Automatic (recommended):** the plugin checks the bridge profile on startup.
The first run — or any run where the profile is missing — opens a dialog:
click the install button and the four profile files are written to
`~/.dsh/profiles/deepshian/`. `cordis.patch.yml` is generated with your
machine's real home path, so nothing needs manual editing. You can also
reinstall anytime from **Settings → Reinstall bridge profile**.

**Manual fallback:** copy the profile folder, then fix the machine path by
hand:

```powershell
Copy-Item .\dsh-profile\deepshian\* "$env:USERPROFILE\.dsh\profiles\deepshian\" -Recurse -Force
```

Edit `cordis.patch.yml` inside that directory so the `file:///` path points at
your user home (the repo copy ships a `<YOUR-HOME>` placeholder).

Smoke test — you should see `{"t":"ready",...}` followed by streaming events:

```powershell
'{"prompt":"Reply PONG"}' | dsh --profile deepshian
```

> The profile's `cordis.patch.yml` injects the local cordis plugin via `file:///...mjs`; the bundles only contain `@deepseek-ai/dsh-base` (the full agent core), and models/credentials are inherited from your own dsh config.

### 2 Install into Obsidian

**Option A: Download from Releases**

Go to the [Releases page](https://github.com/zhenghaoyang24/obsidian-plugin-deepshian/releases) and download these **three files** from the latest release:

| File             | Purpose                                 |
| ---------------- | --------------------------------------- |
| `main.js`        | Plugin main program                     |
| `manifest.json`  | Plugin manifest (id / version / description) |
| `styles.css`     | Plugin styles                           |

Put them into the vault's plugin folder `<vault>/.obsidian/plugins/deepshian/` (create it first if needed):

```powershell
New-Item -ItemType Directory -Force "<vault>/.obsidian/plugins/deepshian/" | Out-Null
Copy-Item "$env:USERPROFILE\Downloads\main.js", "$env:USERPROFILE\Downloads\manifest.json", "$env:USERPROFILE\Downloads\styles.css" "<vault>/.obsidian/plugins/deepshian/"
```

Then: **Settings → Community plugins → Enable DeepShian** → click the 🤖 icon in the left sidebar to open chat.

**Option B: Install from the community plugin store**

Open Obsidian → **Settings → Community plugins → Browse** → search **deepshian** → **Install** → **Enable**, then click the 🤖 icon in the left sidebar to open chat.

### 3 Build from source (optional)

```bash
npm install
npm run build     # type-check and bundle into build/ (main.js + manifest.json + styles.css)
npm run dev       # optional: watch-mode incremental builds
```

The output lands in `build/` — the same three files (`main.js`, `manifest.json`, `styles.css`) — copy them into the vault's plugin folder:

```powershell
Copy-Item .\build\* "<vault>/.obsidian/plugins/deepshian/"
```

### 4 Plugin settings

| Setting             | Default       | Description                                      |
| ------------------- | ------------- | ------------------------------------------------ |
| **dsh command**     | `dsh`         | Full path if `dsh` is not on PATH                |
| **Bridge profile**  | `deepshian`   | Profile that carries the JSONL bridge plugin (auto-installed on first run) |
| **Start read-only** | Off           | New conversations open in read-only mode         |
| **Debug logging**   | Off           | Log unparsed stdout lines and harness stderr to the console |
