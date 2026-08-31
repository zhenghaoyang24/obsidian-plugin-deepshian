import { t as tt } from "../i18n";
import type { BridgeStatus, ChatMode } from "../bridge/types";

export interface ToolEntry {
	callId: string;
	name: string;
	input: unknown;
	output?: string;
	isError?: boolean;
	done: boolean;

	detailsEl?: HTMLDetailsElement;
	stateEl?: HTMLElement; // .dshc-dot
	summaryEl?: HTMLElement; // .dshc-sum
	outputEl?: HTMLPreElement;
}

export interface AssistantEntry {
	kind: "assistant";
	text: string;
	reasoning: string;
	tools: ToolEntry[];
	usage?: Record<string, number>;
	error?: string;

	rootEl?: HTMLElement;
	footEl?: HTMLElement; // copy + usage row, revealed when the turn finishes
	statusEl?: HTMLElement; // shimmering "Thinking…" + clock
	clockEl?: HTMLElement;
	reasoningEl?: HTMLDetailsElement;
	reasoningSumEl?: HTMLElement;
	reasoningBodyEl?: HTMLElement;
	textEl?: HTMLElement;
	toolsEl?: HTMLElement;
	usageEl?: HTMLElement;
	errorEl?: HTMLElement;
}

export interface UserEntry {
	kind: "user";
	text: string;
}

export type Entry = AssistantEntry | UserEntry;

export const RENDER_THROTTLE_MS = 120;

/** Per-mode labels/descriptions follow the dsh web permission-preset wording. */
export function modeMeta(mode: ChatMode): { label: string; title: string } {
	return mode === "readonly"
		? {
				label: tt("仅查看", "Read Only"),
				title: tt(
					"仅查看：读取文件、检索工作区，不做任何修改。",
					"Inspect only: read files and search the workspace; nothing is modified.",
				),
			}
		: {
				label: tt("工作区写入", "Workspace Write"),
				title: tt(
					"允许在工作区内写入文件并执行命令。",
					"Write inside the workspace and permitted temporary directories.",
				),
			};
}

/** Compact localized words for the header status chip (no model name here). */
export function statusText(status: BridgeStatus): string {
	switch (status) {
		case "stopped":
			return tt("已停止", "stopped");
		case "connecting":
			return tt("连接中…", "connecting");
		case "ready":
			return tt("就绪", "ready");
		case "running":
			return tt("生成中…", "running");
	}
}

/** Copy button label; re-evaluated so a language switch is picked up live. */
export const copyLabel = (): string => tt("复制", "Copy");
