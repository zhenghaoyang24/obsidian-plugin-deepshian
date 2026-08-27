import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import { installProfile, profileDir } from "./profile-install";

/**
 * Shown on first startup (or whenever the bridge profile is missing): explains
 * what the profile is, and installs it into the dsh home when the user clicks
 * the button — no silent writes outside the vault. The only way out is
 * installing; on success the plugin reconnects the bridge (onInstalled).
 */
export class ProfileInstallModal extends Modal {
	private installing = false;

	constructor(
		app: App,
		private profileName: string,
		private dshCommand: string,
		private onInstalled?: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: "DeepShian 需要安装桥接 profile" });
		contentEl.createEl("p", {
			text:
				"DeepShian 通过本机的 dsh 驱动 AI，所有对话都在本地完成，不会上传任何数据。首次使用需要把桥接 profile 安装到 dsh home：",
		});
		contentEl.createEl("p", { text: profileDir(this.profileName) });
		contentEl.createEl("p", {
			text:
				`当前检测不到 profile（"${this.profileName}"）。点击下方按钮会自动创建该目录并写入 4 个配置文件，` +
				`之后插件通过 "${this.dshCommand || "dsh"} --profile ${this.profileName}" 启动。`,
		});

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("我知道了")
				.setCta()
				.onClick(() => void this.doInstall(button)),
		);
	}

	private async doInstall(button: ButtonComponent): Promise<void> {
		if (this.installing) return;
		this.installing = true;
		button.setDisabled(true).setButtonText("安装中…");
		try {
			installProfile(this.profileName);
			new Notice("DeepShian: 桥接 profile 已安装 ✓");
			this.close();
			this.onInstalled?.();
		} catch (err) {
			new Notice(
				`DeepShian: 安装失败 — ${String(err)}。可手动把项目 dsh-profile/deepshian 目录复制到 ${profileDir(this.profileName)}，` +
					"并把 cordis.patch.yml 中的路径改为本机用户目录。",
			);
			this.installing = false;
			button.setDisabled(false);
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}