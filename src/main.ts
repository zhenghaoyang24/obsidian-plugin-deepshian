import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { DshBridge } from "./bridge";
import { DshChatView, VIEW_TYPE_DSH_CHAT } from "./chat-view";
import { applyLanguageSetting, t } from "./i18n";
import { ProfileInstallModal } from "./install-modal";
import { detectProfile, installProfile, patchPathHealthy, profileDir } from "./profile-install";
import { DEFAULT_SETTINGS, DshSettingTab, DshSettings } from "./settings";
import type { BridgeStatus, ChatMode, DshEvent } from "./types";

export default class DshBridgePlugin extends Plugin {
	settings!: DshSettings;
	bridge!: DshBridge;

	private view: DshChatView | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		// Resolve zh/en (auto = follow the Obsidian language) before any string
		// is rendered — commands, notices, and the settings tab all read it.
		applyLanguageSetting(this.settings.language);

		// 0.1.x defaulted to the "obsidian" bridge profile; carry old data forward.
		if (this.settings.profile === "obsidian") {
			this.settings.profile = DEFAULT_SETTINGS.profile;
			await this.saveSettings();
		}

		this.addSettingTab(new DshSettingTab(this.app, this));

		this.bridge = new DshBridge({
			onEvent: (event: DshEvent) => this.view?.handleEvent(event),
			onStatus: (status: BridgeStatus, info?: string) => this.view?.handleStatus(status, info),
		});

		this.registerView(VIEW_TYPE_DSH_CHAT, (leaf: WorkspaceLeaf) => new DshChatView(leaf, this));

		const open = (): void => void this.activate(false);
		const fresh = (): void => void this.activate(true);

		// Command/ribbon names are registered once per load; a language switch
		// applies to them the next time the plugin loads.
		this.addRibbonIcon("bot", t("打开 DSH 对话", "Open DSH chat"), open);
		this.addCommand({ id: "open-dsh-chat", name: t("打开 DSH 对话", "Open DSH chat"), callback: open });
		this.addCommand({
			id: "new-dsh-chat",
			name: t("新建 DSH 对话", "New DSH chat"),
			callback: () => void this.activate(true),
		});

		this.app.workspace.onLayoutReady(() => {
			this.checkProfile();
			if (this.app.workspace.getLeavesOfType(VIEW_TYPE_DSH_CHAT).length > 0) return;
			void this.activate(false).catch(() => {});
		});
	}

	onunload(): void {
		this.bridge?.stop();
	}

	// ----------------------------------------------------------------- view
	bindView(view: DshChatView): void {
		this.view = view;
	}
	unbindView(view: DshChatView): void {
		if (this.view === view) this.view = null;
	}

	async activate(reset: boolean): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DSH_CHAT);
		let leaf: WorkspaceLeaf | null = existing[0] ?? null;
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
		}
		if (!leaf) {
			new Notice(t("DSH 对话：无法创建侧边栏面板", "DSH chat: cannot create a sidebar leaf"));
			return;
		}
		await leaf.setViewState({ type: VIEW_TYPE_DSH_CHAT, active: true });
		if (reset) (leaf.view as DshChatView).startNewChat();
		// revealLeaf() requires Obsidian >= 1.7.2, newer than the declared
		// minAppVersion 1.5.7. The view was just loaded and activated by the
		// awaited setViewState above, so setActiveLeaf() (available since 0.16.3)
		// brings it to the foreground with the same visible result.
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	// --------------------------------------------------------------- bridge
	vaultCwd(): string {
		return (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
	}

	ensureBridge(force = false): void {
		if (force || !this.bridge.alive) {
			this.bridge.start({
				command: this.settings.command,
				profile: this.settings.profile,
				cwd: this.vaultCwd(),
				debug: this.settings.debug,
			});
		}
	}

	restartBridge(): void {
		this.ensureBridge(true);
	}

	sendPrompt(prompt: string, mode: ChatMode): boolean {
		this.ensureBridge();
		return this.bridge.send(prompt, mode);
	}

	/** Forward a control command to the bridge process (models / sessions). */
	sendCommand(command: Record<string, unknown>): boolean {
		this.ensureBridge();
		return this.bridge.sendCommand(command);
	}

	bridgeStatus(): BridgeStatus {
		return this.bridge.status;
	}

	// ------------------------------------------------------------ profile
	/**
	 * First-run / repair gate. When the profile exists but its
	 * cordis.patch.yml carries a stale machine path, rewrite it silently.
	 * When the profile does not exist at all, open the install dialog —
	 * installation only happens after the user clicks the button, and the
	 * bridge reconnects automatically once the install succeeds.
	 */
	checkProfile(): void {
		const name = this.settings.profile;
		if (patchPathHealthy(name)) return;
		if (detectProfile(name)) {
			try {
				installProfile(name);
				new Notice(t("DeepShian: 桥接 profile 已修复", "DeepShian: bridge profile repaired"));
			} catch (err) {
				new Notice(
					t("DeepShian: 桥接 profile 修复失败 — ", "DeepShian: failed to repair bridge profile — ") +
						String(err),
				);
			}
			return;
		}
		new ProfileInstallModal(this.app, name, this.settings.command, () => this.restartBridge()).open();
	}

	/** Settings-triggered manual (re)install of the bridge profile. */
	installProfileNow(): void {
		try {
			installProfile(this.settings.profile);
			new Notice(t("DeepShian: 桥接 profile 已安装 ✓", "DeepShian: bridge profile installed ✓"));
		} catch (err) {
			new Notice(
				`${t("DeepShian: 安装失败 — ", "DeepShian: installation failed — ")}${String(err)}\n` +
					t("目标目录：", "Target directory: ") +
					profileDir(this.settings.profile),
			);
		}
	}

	// -------------------------------------------------------------- language
	/** Called by the settings tab after the language changes mid-session. */
	onLanguageChanged(): void {
		this.view?.relocalize();
	}

	// ------------------------------------------------------------ settings
	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
