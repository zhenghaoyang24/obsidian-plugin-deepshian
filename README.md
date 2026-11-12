# DeepShian

**Use DeepSeek Harness from your Obsidian sidebar to ask about notes and work with your vault.**

English · [简体中文](README.zh.md)

[Upstream project](https://github.com/zhenghaoyang24/obsidian-plugin-deepshian) · [Patch branch](https://github.com/mzh-nuist/obsidian-plugin-deepshian/tree/codex/fix-harness-output) · [Upstream issues](https://github.com/zhenghaoyang24/obsidian-plugin-deepshian/issues)

> **About this branch:** This is a compatibility patch for DeepShian 1.3.0. It restores replies and history with newer Harness versions, separates reasoning from answers, displays complete model names, and fixes provider switching inside existing conversations. These changes are not included in the upstream 1.3.0 release. The manifest still says `1.3.0`; no new release tag has been published for this branch.

## What this patch fixes

| Before | With this patch |
| --- | --- |
| A turn finishes and tool cards appear, but no answer is visible. | Subscribe to the current live-output feed and recover text from completed messages. |
| Reasoning blocks can be mistaken for answer text when recovering a completed message. | Extract only text blocks; keep reasoning in its own channel. |
| Receiving both streamed text and the completed answer can produce duplicates. | Append only the missing suffix of the completed answer. |
| An existing session opens with a title but no conversation. | Read current Session snapshots, with a fallback for older event arrays. |
| The Think disclosure and its preview distract from the answer. | Hide them by default; enable **Show thinking** whenever wanted. |
| Long model names are cut off, or a namespaced id displays only as `deepseek`. | Wrap the full name in the menu and trigger, preserve the complete id, and show provider/id details on hover. |
| The picker shows a new provider, but an existing conversation keeps using its previous route. | Select the model on the active Agent, read its actual selection when reopening history, and wait for queued switches before sending a prompt. |

The missing-output symptom is also reported in [upstream issue #1](https://github.com/zhenghaoyang24/obsidian-plugin-deepshian/issues/1).

## What you can do

- Ask questions about notes without leaving Obsidian.
- Type `@` to reference a vault file or folder.
- Use **Read Only** to inspect material, or **Workspace Write** when you want the agent to make changes.
- Read streamed answers and tool-call cards; show or hide the separate Think panel.
- Choose a model available in your DSH installation, including switching providers within the same conversation.
- Open and manage conversations that share storage with dsh web.
- Use the Chinese or English interface.

## Requirements

| Component | Requirement |
| --- | --- |
| Obsidian | Desktop application. The plugin declares a minimum of 1.5.7; manual checks used 1.15.0 on Windows. |
| DeepSeek Harness | An existing installation with a working `dsh` launcher and configured model access. The bridge fixes were manually checked with 0.2.2-rc.1. |
| Build tools | Git, npm, and Node.js 22 LTS or a newer supported LTS to build this source branch. The repository release workflow uses Node.js 22. |

A desktop DSH installation may include its own runtime. Follow the requirements of your DSH distribution; a globally installed `dsh` command is not mandatory if you provide the full launcher path.

## Install this patched branch

### 1. Build the plugin

```bash
git clone --branch codex/fix-harness-output --single-branch https://github.com/mzh-nuist/obsidian-plugin-deepshian.git
cd obsidian-plugin-deepshian
npm ci
npm test
npm run build
```

`npm run build` runs lint and type checks, then creates these three files:

```text
build/
├── main.js
├── manifest.json
└── styles.css
```

**GitHub's Download ZIP contains source code. It is not a ready-to-install plugin package.** Installing the upstream community-store version or downloading upstream 1.3.0 again will not install this patch.

### 2. Copy the three files into your vault

Temporarily disable DeepShian in Obsidian. If it is already installed, keep a backup of its existing three plugin files, then copy the three files from `build/` into:

```text
<vault>/.obsidian/plugins/deepshian/
```

Keep your existing `data.json`, which contains plugin settings. You do not need to copy your vault, conversation logs, or DSH credentials into this repository.

### 3. Connect DSH

1. Enable DeepShian under **Settings → Community plugins**.
2. Open **Settings → DeepShian**. Leave **dsh command** as `dsh` if it is on PATH; otherwise enter the full path to your existing launcher.
3. Follow the bridge-profile installation prompt on first use. An existing mismatched bridge profile is refreshed by the plugin.
4. Open **DSH chat** using the bot icon on the left ribbon.
5. Send: `Reply exactly PING_OK. Do not read files or call tools.`

You should see `PING_OK` in the conversation. **Ready** alone confirms the bridge started; receiving an answer confirms the round trip.

## Use Command Code GOAT credits

Command Code's [Provider API](https://commandcode.ai/docs/provider) supports GOAT accounts and meters requests against the plan's model access and credits. Use your own Command Code account and API key; installing this fork does not provide a subscription or shared credits.

DeepShian uses its own DSH profile, normally `deepshian`. A provider configured in the desktop or web profile is not automatically available in this separate profile.

1. Initialize DeepShian once using the steps above.
2. Make the credential reference `COMMANDCODE_API_KEY` available through DSH's credential management. If another DSH profile already uses this shared reference, reuse it; do not put the key itself in the YAML file or this repository.
3. Back up `$DSH_HOME/profiles/deepshian/cordis.patch.yml` (by default `~/.dsh/profiles/deepshian/cordis.patch.yml`). Merge the entries from [the example configuration](examples/commandcode-goat.patch.yml) into it. Keep the existing `deepshian-bridge` insert. If `llm-pi-ai` or `agent-default-model` already exists, merge that entry instead of adding a duplicate id; preserve other provider routes.
4. When no task is running, disable and re-enable DeepShian. Start a new conversation and choose **DeepSeek V4.1 Flash Fast** under **commandcode** in the model menu.
5. Send `Reply exactly GOAT_OK. Do not read files or call tools.` Confirm the answer appears.

The example uses `https://api.commandcode.ai/provider/v1` with OpenAI Chat Completions. It declares two text-only model choices and defaults to `deepseek/deepseek-v4.1-flash-fast`. Use the model menu to switch between the Command Code route and `deepseek-account`; the latter uses the DeepSeek account route. Model availability and credits follow your provider account, not this plugin's display name.

The route and model above were checked with a real bridge request and an Obsidian reply. The example itself was structurally checked; vision input and other Command Code models were not tested. A bridge-profile reinstall or refresh can replace manual profile edits, so keep your provider configuration backed up. Changing the YAML does not change an already running bridge's selected model until it reloads.

### Switch providers in an existing conversation

Open the conversation, wait for its current work to finish, and choose the model under the intended **provider** in the model menu. The next request uses that conversation's selection and retains its history. Reopening the conversation restores its saved route; switching it does not change other conversations or the default for new chats.

Before the first message of a blank new chat, choosing a model updates the default used to create it. Changing a default alone does not retarget an existing conversation. A prompt submitted immediately after a model switch waits for that switch to settle.

For example, `commandcode/deepseek/deepseek-v4.1-flash-fast` and `deepseek-account/deepseek-flash` are separate provider routes. If a conversation reports **Insufficient Balance**, check its selected provider and that provider's credits. Switching providers does not transfer credits between accounts. Per-session switching requires the Harness Agent model-selection API; incompatible versions report an update error.

For the DSH adapter and credential-reference format, see the [official pi-ai adapter documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md).

## Everyday use

Start with **Read Only** when you only want to read or ask questions. For example, type `@`, select a note, then ask:

> Summarize this note in three points. Do not modify any files.

Use **Workspace Write** for a concrete editing task. The agent can then modify vault files and use tools according to the Harness permission policy. Enter sends a message; Shift+Enter inserts a new line. Type `/` to see available commands and skills.

For shared history, use one surface at a time for the same conversation: avoid sending to it simultaneously from DeepShian and dsh web.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| Plugin language | Auto | Follow Obsidian, or select Chinese / English. |
| dsh command | `dsh` | Command or full path to your installed DSH launcher. |
| Bridge profile | `deepshian` | Profile passed to the launcher. |
| Reinstall bridge profile | Manual action | Restore the embedded bridge files and this machine's profile path. Back up custom profile changes before using it. |
| Show thinking | Off | Show the separate Think disclosure and preview. This changes presentation, not the model's reasoning settings. |
| Start read-only | Off | Start new sidebars in Read Only when enabled. The default is Workspace Write. |
| On open | Start a new conversation | Choose a new conversation or resume the most recent one for this vault. |
| Debug logging | Off | Send harness stderr and unparsed output to Obsidian's developer console for diagnosis. |

## Troubleshooting

| Symptom | Check first |
| --- | --- |
| Tool cards appear, but no answer | Confirm that `main.js` came from this branch's build. A reported version of 1.3.0 alone cannot distinguish the patch from upstream. Disable and re-enable the plugin after copying files. |
| DSH cannot start | Check the launcher path and verify that the same DSH installation works on its own. |
| Authentication, quota, or model errors | Check the configured provider in DSH. This plugin does not replace the provider's login or service requirements. |
| Switching providers appears ineffective in an old conversation | Install this branch's current build, reload DeepShian, reopen the conversation, and choose the intended provider there. Changing only the deployment default does not update an existing session. |
| Long thinking text appears | Turn off **Show thinking**. Reasoning mixed into the answer body indicates an older bridge or build; check the installed files. |
| A saved conversation appears empty | Use the patched bridge and reopen the session. The underlying conversation need not be deleted. |
| The patch disappears after an update | A community-store update can replace the installed files. Rebuild the patch branch or check whether the upstream update already contains the fix. |

## Where data goes

The plugin launches a **local DSH process** and uses your configured Harness services. This does **not** guarantee offline inference or that data stays on the device: prompts, selected note context, and logs may be handled by the model provider and other services configured in DSH. Review that configuration before sending private material.

Workspace Write allows real file changes. Hide/show thinking does not change file permissions, model reasoning, or service usage.

## Validation and development

```bash
npm ci
npm test
npm run build
npm run dev
```

The patch was checked with **38 passing tests**, plus lint, TypeScript checks, and a production build. Compatibility tests execute the shipped bridge module with synthetic events and inert SDK imports; they do not call a model or read a real vault. They cover completed-message recovery, reasoning exclusion, stream deduplication, missing suffixes, concurrent sessions, current live-frame routing, and history replay. Five model-switch tests exercise the actual JSONL handler and prompt path with session-owned model fixtures: switching an active session, keeping other conversations independent, waiting for a saved default, restoring a persisted selection after restart, and ordering rapid switches.

The underlying bridge fixes were also exercised in Obsidian 1.15.0 on Windows with Harness 0.2.2-rc.1: a test reply rendered and a saved conversation displayed its answer. Other platforms and Harness versions have not been manually validated in this work.

A separate live two-turn probe selected the official route locally, switched back to Command Code, and verified a reply recalling the first turn's test token. The persisted log recorded both selections and the Command Code request route. No inference request was sent to the official route during that probe. An existing conversation was also reopened in Obsidian with its saved Command Code selection; its original messages were not resent automatically.

## Credits and license

DeepShian was created by [zhenghaoyang24](https://github.com/zhenghaoyang24). This patch is maintained in [mzh-nuist's fork](https://github.com/mzh-nuist/obsidian-plugin-deepshian).

[MIT License](LICENSE). Original copyright and attribution are preserved.
