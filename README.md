<p align="center">
  <span style="font-size: 2em; font-weight: bold;"><span style="color: white;">Deep</span><span style="color: #7c3aed;">Shian</span></span>
</p>

<img width="1858" height="1014" alt="image" src="https://github.com/user-attachments/assets/004b3af4-4b5b-4f6f-b920-cda4e7835df0" style="width: 100%; height: auto; display: block;" />

English | [简体中文](README.zh.md)

![DSH](<https://img.shields.io/badge/Powered%20by-DeepSeek%20Harness-6366f1?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0tMiAxNS41di03bDUgMy41LTUgMy41eiIvPjwvc3ZnPg==>)
![Obsidian](<https://img.shields.io/badge/Obsidian-Desktop%20Only-7c3aed?style=flat-square&logo=obsidian&logoColor=white>)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue?style=flat-square&logo=typescript&logoColor=white)

DeepShian brings [DeepSeek Harness](https://www.deepseek.com/harness/) into Obsidian's right sidebar. There is no cloud API: it talks to the `dsh` already installed on your machine, so you get the full agent experience — streaming answers, thinking steps, tool-call cards — and it can read and edit your vault files directly.

## Features

- 🔒 Fully local: answers, tool calls, and file operations are all driven by your local `dsh`.
- ✨ Model picker: choose any model, just like in dsh web.
- 💬 Conversation sync: the DeepShian workspace syncs with dsh web, including conversation history, archive, and deletion.
- 🔐 Access control: choose the agent's access mode like in dsh web — **Read Only** or **Workspace Write**.
- 📎 File references: type `@` in the input to pick a file or folder from your vault — the agent reads it with full context.
- 🎨 Chat experience: the same chat experience as dsh web, including streaming output, thinking steps, tool calls, and more.
- 🌐 Multilingual: fully bilingual UI (中文 / English) that follows your Obsidian language.

## Requirements

| Dependency            | Version   | Notes                                          |
| --------------------- | --------- | ---------------------------------------------- |
| **Obsidian**    | ≥ 1.5.7  | Desktop only                                   |
| **Node.js**     | ≥ 18     | Runtime for the `dsh` command                  |
| **DeepSeek Harness** | /         | Installed globally so that `dsh` is available  |

```bash
# Verify dsh is installed
dsh --version
```

## Quick Start

### 1 Install into Obsidian

**Option A: Install from the community plugin store**

Open Obsidian → **Settings → Community plugins → Browse** → search **deepshian** → **Install** → **Enable**, then click the 🤖 icon in the left sidebar to open chat.

**Option B: Download from Releases**

Go to the [Releases page](https://github.com/zhenghaoyang24/obsidian-plugin-deepshian/releases) and download these three files from the latest release: `main.js`, `manifest.json`, `styles.css`. Put them into the vault's plugin folder `<vault>/.obsidian/plugins/deepshian/`. Then: **Settings → Community plugins → Enable DeepShian** → click the 🤖 icon in the left sidebar to open chat.

### 2 Build from source

```bash
npm install
npm run build     # type-check and bundle into build/ (main.js + manifest.json + styles.css)
npm run dev       # optional: watch-mode incremental builds
```

The output lands in `build/` — the same three files (`main.js`, `manifest.json`, `styles.css`) — copy them into the vault's plugin folder.

### 3 Plugin settings

| Setting                 | Default           | Description                                                                                                       |
| ----------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Plugin language**     | Auto              | UI language (settings page included): Auto follows Obsidian — Chinese for zh, English otherwise — or force 中文 / English |
| **dsh command**         | `dsh`             | Full path if `dsh` is not on PATH                                                                                 |
| **Bridge profile**      | `deepshian`       | Profile passed as `--profile`; auto-installed on first run                                                        |
| **Reinstall bridge profile** | —          | Auto-installs on first run (dialog) or repairs the profile path on this machine (e.g. when dsh was installed after the plugin) |
| **Start read-only**     | Off               | Every new sidebar starts in read-only mode                                                                        |
| **On open**             | Start new conversation | Whether opening the sidebar starts a new conversation or resumes the most recent one for this vault          |
| **Debug logging**       | Off               | Log unparsed stdout lines and harness stderr to the developer console                                              |

## License

This project is open source under the [MIT License](LICENSE).

## Contributing

Issues and Pull Requests are welcome.

1. Fork the repository and create your feature branch (`git checkout -b feature/your-feature`).
2. Commit your changes (`git commit -m 'feat: add some feature'`).
3. Push to the branch (`git push origin feature/your-feature`).
4. Open a Pull Request.

---

Powered by DeepSeek Harness.
