import { App, PluginSettingTab, Setting } from "obsidian";
import type DshBridgePlugin from "./main";
import { profileDir } from "./profile-install";

export interface DshSettings {
	/** dsh profile to boot; must contain the deepshian-bridge insert. */
	profile: string;
	/** Executable used to launch dsh ("dsh", a full dsh.cmd path, etc.). */
	command: string;
	/** Start every chat in read-only mode. */
	readonlyByDefault: boolean;
	/** What the sidebar does when it opens: a fresh conversation or the last one. */
	onOpen: "new" | "resume";
	debug: boolean;
}

export const DEFAULT_SETTINGS: DshSettings = {
	profile: "deepshian",
	command: "dsh",
	readonlyByDefault: false,
	onOpen: "new",
	debug: false,
};

export class DshSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: DshBridgePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("DSH launcher").setHeading();
		new Setting(containerEl)
			.setName("dsh command")
			.setDesc('Executable used to boot the harness, e.g. "dsh" (on PATH) or a full path like "D:\\\\Node\\\\...\\\\dsh.cmd".')
			.addText((t) =>
				t.setValue(this.plugin.settings.command).onChange(async (v) => {
					this.plugin.settings.command = v.trim() || DEFAULT_SETTINGS.command;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Bridge profile")
			.setDesc('Profile passed as "--profile". The deepshian profile is installed automatically on first run.')
			.addText((t) =>
				t.setValue(this.plugin.settings.profile).onChange(async (v) => {
					this.plugin.settings.profile = v.trim() || DEFAULT_SETTINGS.profile;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Reinstall bridge profile")
			.setDesc(
				`Auto-installs on first run (dialog) or repairs the profile at ${profileDir(this.plugin.settings.profile)}. ` +
					"Use this if dsh was installed after the plugin, or the profile path no longer matches this machine.",
			)
			.addButton((button) =>
				button
					.setButtonText("Install / Repair")
					.setCta()
					.onClick(() => this.plugin.installProfileNow()),
			);

		new Setting(containerEl).setName("Chat").setHeading();
		new Setting(containerEl)
			.setName("Start read-only")
			.setDesc("Every new sidebar starts in read-only mode; writable remains one click away.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.readonlyByDefault).onChange(async (v) => {
					this.plugin.settings.readonlyByDefault = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("On open")
			.setDesc(
				"Whether opening the sidebar starts a new conversation or resumes the most recent one for this vault. A conversation is only recorded once you send its first message.",
			)
			.addDropdown((d) =>
				d
					.addOption("new", "Start a new conversation（新对话）")
					.addOption("resume", "Resume the last conversation（恢复上次会话）")
					.setValue(this.plugin.settings.onOpen)
					.onChange(async (v) => {
						this.plugin.settings.onOpen = v === "resume" ? "resume" : "new";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Diagnostics").setHeading();
		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Log unparsed stdout lines and harness stderr to the developer console.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.debug).onChange(async (v) => {
					this.plugin.settings.debug = v;
					await this.plugin.saveSettings();
				}),
			);
	}
}
