import { App, PluginSettingTab, Setting } from "obsidian";
import { applyLanguageSetting, t, type LanguageSetting, type Locale } from "../i18n";
import type DshBridgePlugin from "../main";
import { profileDir } from "../profile/install";

export interface DshSettings {
  /** dsh profile to boot; must contain the deepshian-bridge insert. */
  profile: string;
  /** Executable used to launch dsh ("dsh", a full dsh.cmd path, etc.). */
  command: string;
  /** Start every chat in read-only mode. */
  readonlyByDefault: boolean;
  /** What the sidebar does when it opens: a fresh conversation or the last one. */
  onOpen: "new" | "resume";
  /** Plugin UI language: "auto" follows Obsidian, otherwise forced zh/en. */
  language: LanguageSetting;
  debug: boolean;
}

export const DEFAULT_SETTINGS: DshSettings = {
  profile: "deepshian",
  command: "dsh",
  readonlyByDefault: false,
  onOpen: "new",
  language: "auto",
  debug: false,
};

export class DshSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: DshBridgePlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName(t("语言", "Language")).setHeading();
    new Setting(containerEl)
      .setName(t("插件语言", "Plugin language"))
      .setDesc(
        t(
          "插件界面（含本设置页）的显示语言。“自动”跟随 Obsidian 语言：中文显示中文，其他语言一律显示英文。",
          "Display language for the plugin UI, including this settings page. “Auto” follows the Obsidian language: Chinese for zh, English for everything else.",
        ),
      )
      .addDropdown((d) =>
        d
          .addOption("auto", t("自动（跟随 Obsidian）", "Auto (follow Obsidian)"))
          .addOption("zh", "中文")
          .addOption("en", "English")
          .setValue(this.plugin.settings.language)
          .onChange(async (v) => {
            const language: LanguageSetting =
              v === "zh" || v === "en" ? (v as Locale) : "auto";
            this.plugin.settings.language = language;
            await this.plugin.saveSettings();
            // Re-resolve the effective locale, then repaint this tab and
            // any open chat view so the switch is visible immediately.
            applyLanguageSetting(language);
            this.display();
            this.plugin.onLanguageChanged();
          }),
      );

    new Setting(containerEl).setName(t("DSH 启动器", "DSH launcher")).setHeading();
    new Setting(containerEl)
      .setName(t("dsh 命令", "dsh command"))
      .setDesc(
        t(
          '用于启动 harness 的可执行文件，例如 "dsh"（在 PATH 中）或完整路径 "D:\\\\Node\\\\...\\\\dsh.cmd"。',
          'Executable used to boot the harness, e.g. "dsh" (on PATH) or a full path like "D:\\\\Node\\\\...\\\\dsh.cmd".',
        ),
      )
      .addText((text) =>
        text.setValue(this.plugin.settings.command).onChange(async (v) => {
          this.plugin.settings.command = v.trim() || DEFAULT_SETTINGS.command;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName(t("桥接 profile", "Bridge profile"))
      .setDesc(
        t(
          '传递给 "--profile" 的 profile 名称。deepshian profile 会在首次运行时自动安装。',
          'Profile passed as "--profile". The deepshian profile is installed automatically on first run.',
        ),
      )
      .addText((text) =>
        text.setValue(this.plugin.settings.profile).onChange(async (v) => {
          this.plugin.settings.profile = v.trim() || DEFAULT_SETTINGS.profile;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName(t("重新安装桥接 profile", "Reinstall bridge profile"))
      .setDesc(
        t(
          `首次运行时自动安装（弹窗确认），或修复位于 ${profileDir(this.plugin.settings.profile)} 的 profile。` +
            "若 dsh 在插件之后才安装，或 profile 中的路径已与本机不符，请使用此按钮。",
          `Auto-installs on first run (dialog) or repairs the profile at ${profileDir(this.plugin.settings.profile)}. ` +
            "Use this if dsh was installed after the plugin, or the profile path no longer matches this machine.",
        ),
      )
      .addButton((button) =>
        button
          .setButtonText(t("安装 / 修复", "Install / Repair"))
          .setCta()
          .onClick(() => this.plugin.installProfileNow()),
      );

    new Setting(containerEl).setName(t("对话", "Chat")).setHeading();
    new Setting(containerEl)
      .setName(t("默认只读启动", "Start read-only"))
      .setDesc(
        t(
          "每个新侧边栏都以只读模式启动；一键即可切换为可写入。",
          "Every new sidebar starts in read-only mode; writable remains one click away.",
        ),
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.readonlyByDefault).onChange(async (v) => {
          this.plugin.settings.readonlyByDefault = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName(t("打开时", "On open"))
      .setDesc(
        t(
          "打开侧边栏时是开始新对话，还是恢复本工作区最近一次会话。只有发出第一条消息后才会记录会话。",
          "Whether opening the sidebar starts a new conversation or resumes the most recent one for this vault. A conversation is only recorded once you send its first message.",
        ),
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("new", t("开始新对话", "Start a new conversation"))
          .addOption("resume", t("恢复上次会话", "Resume the last conversation"))
          .setValue(this.plugin.settings.onOpen)
          .onChange(async (v) => {
            this.plugin.settings.onOpen = v === "resume" ? "resume" : "new";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName(t("诊断", "Diagnostics")).setHeading();
    new Setting(containerEl)
      .setName(t("调试日志", "Debug logging"))
      .setDesc(
        t(
          "将未解析的 stdout 行与 harness stderr 输出到开发者控制台。",
          "Log unparsed stdout lines and harness stderr to the developer console.",
        ),
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debug).onChange(async (v) => {
          this.plugin.settings.debug = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
