import { ItemView, MarkdownRenderer, Notice } from "obsidian";
// `tt(zh, en)` resolves against the live locale (i18n module), so strings
// rendered after a language switch come out in the new language immediately.
import { t as tt } from "./i18n";
import type DshBridgePlugin from "./main";
import type {
	BridgeStatus,
	ChatMode,
	DshEvent,
	ModelInfo,
	ModelSelection,
	ReplayTurn,
	SessionSummary,
} from "./types";

export const VIEW_TYPE_DSH_CHAT = "dsh-chat-view";

interface ToolEntry {
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

interface AssistantEntry {
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

interface UserEntry {
	kind: "user";
	text: string;
}

type Entry = AssistantEntry | UserEntry;

const RENDER_THROTTLE_MS = 120;

/** Per-mode labels/descriptions follow the dsh web permission-preset wording. */
function modeMeta(mode: ChatMode): { label: string; title: string } {
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
function statusText(status: BridgeStatus): string {
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
const copyLabel = (): string => tt("复制", "Copy");

/* Minimal inline SVGs copied from the dsh web frontend primitives bundle so the
 * sidebar matches the harness UI pixel-for-pixel. */
function svg(size: number, viewBox: string, inner: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" fill="none" aria-hidden="true">${inner}</svg>`;
}

/** IconSendOutline16 (up arrow) — the dsh composer primary glyph. */
const ICON_SEND = svg(
	16,
	"0 0 16 16",
	'<path fill="currentColor" d="M8.3125 0.981587C8.66767 1.0545 8.97902 1.20558 9.2627 1.43374C9.48724 1.61438 9.73029 1.85933 9.97949 2.10854L14.707 6.83608L13.293 8.25014L9 3.95717V15.0431H7V3.95717L2.70703 8.25014L1.29297 6.83608L6.02051 2.10854C6.26971 1.85933 6.51277 1.61438 6.7373 1.43374C6.97662 1.24126 7.28445 1.04542 7.6875 0.981587C7.8973 0.94841 8.1031 0.956564 8.3125 0.981587Z"/>',
);
/** Stop glyph shown on the primary button while a turn runs. */
const ICON_STOP = svg(
	16,
	"0 0 16 16",
	'<rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor"/>',
);
/** Filled right-pointing triangle — dsh command/tool-row leading glyph. */
const ICON_COMMAND = svg(
	14,
	"0 0 14 14",
	'<path fill="currentColor" d="M4.2 3.1 L10.8 7 L4.2 10.9 Z"/>',
);
/** IconChevronDownOutline14. */
const ICON_CHEVRON = svg(
	14,
	"0 0 14 14",
	'<path fill="currentColor" d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"/>',
);
/** IconCheckOutline16 (menu selected marker). */
const ICON_CHECK = svg(
	14,
	"0 0 16 16",
	'<path fill="currentColor" d="M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z"/>',
);
/** IconThinkOutline14 ("Think" disclosure leading glyph). */
const ICON_THINK = svg(
	14,
	"0 0 14 14",
	'<path fill="currentColor" d="M7.06431 5.93342C7.68763 5.93342 8.19307 6.43904 8.19322 7.06233C8.19322 7.68573 7.68772 8.19123 7.06431 8.19123C6.44099 8.19113 5.9354 7.68567 5.9354 7.06233C5.93555 6.43911 6.44108 5.93353 7.06431 5.93342Z"/><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M8.6815 0.963693C10.1169 0.447019 11.6266 0.374829 12.5633 1.31135C13.5 2.24805 13.4277 3.75776 12.911 5.19319C12.7126 5.74431 12.4386 6.31796 12.0965 6.89729C12.4969 7.54638 12.8141 8.19018 13.036 8.80647C13.5527 10.2419 13.6251 11.7516 12.6883 12.6883C11.7516 13.625 10.242 13.5527 8.8065 13.036C8.19022 12.8141 7.54641 12.4969 6.89732 12.0965C6.31797 12.4386 5.74435 12.7125 5.19322 12.911C3.75777 13.4276 2.2481 13.5 1.31138 12.5633C0.374859 11.6266 0.447049 10.1168 0.963724 8.68147C1.17185 8.10338 1.46321 7.50063 1.82896 6.8924C1.52182 6.35711 1.27235 5.82825 1.08872 5.31819C0.572068 3.88278 0.499714 2.37306 1.43638 1.43635C2.37308 0.499655 3.8828 0.572044 5.31822 1.08869C5.82828 1.27232 6.35715 1.5218 6.89243 1.82893C7.50066 1.46318 8.10341 1.17181 8.6815 0.963693ZM11.3573 8.01154C10.9083 8.62253 10.3901 9.22873 9.80943 9.8094C9.22877 10.3901 8.62255 10.9083 8.01158 11.3572C8.4257 11.5841 8.8287 11.7688 9.21275 11.9071C10.5456 12.3868 11.4246 12.2547 11.8397 11.8397C12.2548 11.4246 12.3869 10.5456 11.9071 9.21272C11.7688 8.82866 11.5841 8.42568 11.3573 8.01154ZM2.56529 8.02912C2.37344 8.39322 2.21495 8.74796 2.09263 9.08772C1.61291 10.4204 1.74512 11.2995 2.16001 11.7147C2.57505 12.1297 3.45415 12.2618 4.78697 11.7821C5.11057 11.6656 5.44786 11.5164 5.7938 11.3367C5.249 10.9223 4.70922 10.4533 4.19029 9.9344C3.57578 9.31987 3.03169 8.67633 2.56529 8.02912ZM6.90708 3.2469C6.24065 3.70479 5.5646 4.26321 4.91392 4.91389C4.26325 5.56456 3.70482 6.24063 3.24693 6.90705C3.72674 7.63325 4.32777 8.37459 5.03892 9.08576C5.64943 9.69627 6.28183 10.2265 6.90806 10.6678C7.59368 10.2025 8.2908 9.63076 8.96079 8.96076C9.6308 8.29075 10.2025 7.59366 10.6678 6.90803C10.2265 6.2818 9.69631 5.6494 9.08579 5.03889C8.37462 4.32773 7.63328 3.72672 6.90708 3.2469ZM11.7147 2.15998C11.2996 1.74509 10.4204 1.61288 9.08775 2.0926C8.74835 2.21479 8.39382 2.37271 8.03013 2.56428C8.67728 3.03065 9.31995 3.5758 9.93443 4.19026C10.4534 4.7092 10.9223 5.24896 11.3368 5.79377C11.5164 5.44785 11.6656 5.11052 11.7821 4.78694C12.2618 3.45416 12.1297 2.57502 11.7147 2.15998ZM4.91197 2.2176C3.57922 1.73788 2.70004 1.86995 2.28501 2.28498C1.87001 2.70003 1.73791 3.5792 2.21763 4.91194C2.31709 5.18822 2.44112 5.47427 2.58677 5.7674C3.01931 5.1887 3.51474 4.6158 4.06529 4.06526C4.61584 3.5147 5.18872 3.01928 5.76743 2.58674C5.47431 2.4411 5.18824 2.31706 4.91197 2.2176Z"/>',
);
/** IconRefreshOutline14 (new chat). */
const ICON_REFRESH = svg(
	14,
	"0 0 14 14",
	'<path fill="currentColor" d="M1.272 6.21348C1.70645 3.08888 4.59169 0.908064 7.71634 1.34239C8.95495 1.51469 10.0438 2.07331 10.8814 2.87755L11.9458 1.81407C12.1347 1.6255 12.4572 1.75911 12.4575 2.02598V5.08751C12.4574 5.25303 12.3233 5.38731 12.1577 5.38731H9.0972C8.82993 5.38731 8.69629 5.06361 8.88528 4.87462L10.0327 3.72618C9.3732 3.09994 8.52006 2.66569 7.5513 2.53087C5.08313 2.18779 2.80376 3.91044 2.46048 6.37852C2.11747 8.84665 3.84009 11.1261 6.30814 11.4693C8.77612 11.8121 11.0557 10.0896 11.399 7.62169L11.9937 7.70372L12.5874 7.78673C12.153 10.9112 9.26756 13.0919 6.1431 12.6578C3.01854 12.2234 0.837738 9.33809 1.272 6.21348Z"/>',
);

/** IconPlusOutline16 — new session button leading glyph. */
const ICON_PLUS = svg(
	16,
	"0 0 16 16",
	'<path fill="currentColor" d="M8 3a.75.75 0 0 1 .75.75v3.5h3.5a.75.75 0 0 1 0 1.5h-3.5v3.5a.75.75 0 0 1-1.5 0v-3.5h-3.5a.75.75 0 0 1 0-1.5h3.5v-3.5A.75.75 0 0 1 8 3Z"/>',
);

/** Archive tray — session-history row action glyph (dsh web menu.archiveSession). */
const ICON_ARCHIVE = svg(
	14,
	"0 0 14 14",
	'<path d="M2.2 3.6h9.6L13 6v6.2a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6l1.2-2.4Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M1.7 6h10.6" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><path d="M7 7.4v3.2M5.6 9 7 10.4 8.4 9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>',
);
/** Copy-to-clipboard glyph used by message and history row copy actions. */
const ICON_COPY = svg(
	14,
	"0 0 16 16",
	'<rect x="4.75" y="4.75" width="9" height="9" rx="1.75" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M11.5 4.75V3.75A1.75 1.75 0 0 0 9.75 2H3.75A1.75 1.75 0 0 0 2 3.75v6A1.75 1.75 0 0 0 3.75 11.5h1" stroke="currentColor" stroke-width="1.2" fill="none"/>',
);

/* dsh permission glyphs: shield + check (read-only) / shield + pencil
 * (workspace-write), lifted verbatim from ui-conversation PermissionSelect. */
const SHIELD_OUTLINE =
	"M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z";
const ICON_MODE_READONLY = svg(
	16,
	"0 0 16 16",
	`<path d="${SHIELD_OUTLINE}" stroke="currentColor" stroke-width="1.31831" stroke-linejoin="round"/><path fill="currentColor" d="M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z"/>`,
);
const ICON_MODE_WRITE = svg(
	16,
	"0 0 16 16",
	'<path fill="currentColor" d="M8.08887 0.251709C8.20479 0.23085 8.32486 0.241168 8.43652 0.282959L15.0215 2.75171C15.2787 2.84819 15.4492 3.09414 15.4492 3.3689V7.0105C15.4492 7.10986 15.4441 7.2081 15.4414 7.30542C15.0285 7.07175 14.5905 6.87695 14.1309 6.73022V3.82495L8.20508 1.60327L2.2793 3.82495V7.0105C2.27936 9.7171 3.4745 11.5379 5.02734 12.7947C5.01025 12.9942 5 13.1962 5 13.4001C5.00001 13.7617 5.02722 14.1169 5.08008 14.4636C2.91555 13.0393 0.961014 10.752 0.960938 7.0105V3.3689C0.960938 3.09417 1.13146 2.84821 1.38867 2.75171L7.97461 0.282959L8.08887 0.251709Z"/><path fill="currentColor" d="M11.3525 5.64688V6.85688H5V5.64688H11.3525Z"/><path fill="currentColor" d="M9.5824 8.29376V9.50376H5V8.29376H9.5824Z"/><path fill="currentColor" d="M14.6647 15.6852H10.0338C10.3878 15.3751 10.7567 15.0517 11.0772 14.7706C11.2531 14.6164 11.4144 14.4746 11.5511 14.3547H14.6647V15.6852Z"/><path fill="currentColor" d="M8.14852 14.1308L7.33925 15.4976C7.22458 15.6912 7.42245 15.9194 7.63037 15.8333L9.09785 15.2254L15.0399 10.0719L14.0905 8.97733L8.14852 14.1308Z"/>',
);
/** IconListPenOutline16 — session-history header button glyph. */
const ICON_HISTORY = svg(
	16,
	"0 0 16 16",
	'<path fill="currentColor" d="M10.8239 3.54733V4.78443H4.63437V3.54733H10.8239Z"/><path fill="currentColor" d="M10.8239 6.12629V7.36338H4.63437V6.12629H10.8239Z"/><path fill="currentColor" d="M9.073 8.70524V9.94234H4.63437V8.70524H9.073Z"/><path fill="currentColor" d="M9.13321 0.573526C10.0076 0.573525 10.7179 0.572522 11.285 0.63397C11.8645 0.696791 12.3743 0.831648 12.8193 1.1548C13.0776 1.34246 13.3056 1.57047 13.4933 1.82875C13.8164 2.2737 13.9513 2.7836 14.0141 3.36303C14.0755 3.93015 14.0745 4.64049 14.0745 5.51485V6.1757L12.7327 7.5629V5.51485C12.7327 4.61092 12.732 3.9862 12.6803 3.5081C12.6298 3.0427 12.5379 2.79497 12.4083 2.61654C12.3033 2.47211 12.176 2.34472 12.0315 2.23977C11.8531 2.11016 11.6054 2.01823 11.14 1.96777C10.6618 1.91601 10.0372 1.91539 9.13321 1.91539H6.32658C5.42262 1.91539 4.79796 1.91604 4.31983 1.96777C3.85451 2.01819 3.60672 2.11029 3.42827 2.23977C3.28392 2.34465 3.15643 2.47223 3.0515 2.61654C2.9219 2.79496 2.82997 3.04274 2.7795 3.5081C2.72774 3.9862 2.72712 4.61092 2.72712 5.51485V10.023C2.72712 10.9273 2.72773 11.5525 2.7795 12.0307C2.82992 12.4959 2.92205 12.7429 3.0515 12.9213C3.15645 13.0657 3.28384 13.1931 3.42827 13.2981C3.60676 13.4277 3.85408 13.5206 4.31983 13.5711C4.79797 13.6228 5.42259 13.6234 6.32658 13.6234H6.87057L5.57707 14.9593C5.03527 14.9556 4.57031 14.9467 4.17476 14.9039C3.59508 14.841 3.08558 14.7063 2.64048 14.383C2.38215 14.1953 2.15422 13.9684 1.96653 13.7101C1.64319 13.2649 1.50851 12.7546 1.4457 12.1748C1.38432 11.6076 1.38525 10.8974 1.38525 10.023V5.51485C1.38525 4.64049 1.38426 3.93015 1.4457 3.36303C1.50853 2.78363 1.64341 2.27368 1.96653 1.82875C2.15417 1.57059 2.38228 1.34239 2.64048 1.1548C3.08544 0.831805 3.59533 0.696762 4.17476 0.63397C4.74193 0.572552 5.45218 0.573525 6.32658 0.573526H9.13321Z"/><path fill="currentColor" d="M14.2193 14.9553H10.0124L11.3744 13.6134H14.2193V14.9553Z"/><path fill="currentColor" d="M8.24493 13.3711L7.49015 14.8806C7.40148 15.058 7.58961 15.2461 7.76695 15.1574L9.27651 14.4027L14.6147 9.09934L13.5832 8.06775L8.24493 13.3711Z"/>',
);
/** IconSparkle16 — model selector pill glyph. */
const ICON_SPARKLE = svg(
	16,
	"0 0 16 16",
	'<path fill="currentColor" d="M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z"/><path fill="currentColor" d="M11.9 1Q12.2 3.7 14.9 4Q12.2 4.3 11.9 7Q11.6 4.3 8.9 4Q11.6 3.7 11.9 1Z"/><path fill="currentColor" d="M12.5 9.4Q12.7 11.4 14.7 11.6Q12.7 11.8 12.5 13.8Q12.3 11.8 10.3 11.6Q12.3 11.4 12.5 9.4Z"/>',
);

/**
 * Render one compile-time-constant SVG icon (see `svg()`) as a detached DOM
 * element. Icons are fixed literals bundled with the plugin — no dynamic data
 * ever reaches this markup — so parsing them with DOMParser is a safe
 * replacement for HTML-string injection into the DOM. The parsed element is cached
 * and deep-cloned per call so the same icon can mount in several places.
 */
const ICON_CACHE = new Map<string, Element>();

function svgIcon(html: string): Element {
	const cached = ICON_CACHE.get(html);
	if (cached) return cached.cloneNode(true) as Element;
	const el = new DOMParser().parseFromString(html, "image/svg+xml").documentElement;
	if (el.nodeName !== "svg") throw new Error("invalid icon markup");
	ICON_CACHE.set(html, el);
	return el.cloneNode(true) as Element;
}

/**
 * The sidebar chat view, mirroring the dsh web conversation UI: streaming
 * markdown, a Think disclosure row with sweep animation, tool disclosure rows,
 * token stats, a rounded composer card whose textarea grows without its own
 * scrollbar, a dsh-style access-mode select at the card's bottom-left, and a
 * circular send button that stays disabled until the current turn finishes.
 */
export class DshChatView extends ItemView {
	private entries: Entry[] = [];
	private mode: ChatMode;
	private currentAssistant: AssistantEntry | null = null;
	private renderTimer: ReturnType<typeof setTimeout> | null = null;
	private clockTimer: ReturnType<typeof setInterval> | null = null;
	private turnStartedAt = 0;

	// session sync + model selection state
	private sessionsCache: SessionSummary[] = [];
	private modelsCache: ModelInfo[] = [];
	private currentSelection: ModelSelection | null = null;
	private activeSessionId = "";

	/** Current session title, resolved by id against the latest sessions payload. */
	private currentSessionTitle = "";
	private sessionsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	/** Low-frequency poll so deletions/archives made in dsh web drop out of the list. */
	private sessionsSyncTimer: ReturnType<typeof setInterval> | null = null;
	/** Set when the boot auto-resume is armed; consumed by the next sessions payload. */
	private pendingResume = false;
	/** Suppress one boot auto-resume because the user explicitly asked for a new chat. */
	private skipNextResume = false;

	private messagesEl!: HTMLElement;
	private columnEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private statusChip!: HTMLElement;
	private headerEl!: HTMLElement;
	/** Header caption: current session title (falls back to 新对话). */
	private titleEl!: HTMLElement;
	private modeTriggerBtn!: HTMLButtonElement;
	private modeTriggerIcon!: HTMLElement;
	private modeTriggerLabel!: HTMLElement;
	private modeMenuEl!: HTMLElement;
	private historyBtn!: HTMLButtonElement;
	private historyPanelEl!: HTMLElement;
	private historyListEl!: HTMLElement;
	/** Chrome labels re-painted by relocalize() after a language switch. */
	private newChatBtn!: HTMLButtonElement;
	private newChatLabelEl!: HTMLElement;
	private historyTitleEl!: HTMLElement;
	private historyFootEl!: HTMLElement;
	private modelWrapEl!: HTMLElement;
	private modelBtn!: HTMLButtonElement;
	private modelBtnLabel!: HTMLElement;
	private modelMenuEl!: HTMLElement;
	private bannerEl!: HTMLElement;

	constructor(leaf: unknown, private plugin: DshBridgePlugin) {
		super(leaf as never);
		this.mode = plugin.settings.readonlyByDefault ? "readonly" : "writable";
	}

	getViewType(): string {
		return VIEW_TYPE_DSH_CHAT;
	}
	getDisplayText(): string {
		return tt("DSH 对话", "DSH chat");
	}
	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("dsh-chat");
		this.buildHeader();
		this.buildHistoryPanel();
		this.messagesEl = this.contentEl.createDiv({ cls: "dshc-scroll" });
		this.columnEl = this.messagesEl.createDiv({ cls: "dshc-column" });
		this.buildComposer();
		this.bannerEl = this.contentEl.createDiv({
			cls: "dsh-banner is-hidden",
			text: "",
		});
		document.addEventListener("pointerdown", this.onDocPointerDown);
		this.plugin.bindView(this);
		this.plugin.ensureBridge();
		this.renderStatus();
		// Keep the history list in step with dsh web: re-query every 12s so a
		// session deleted/archived there disappears here without a manual refresh.
		this.sessionsSyncTimer = setInterval(() => {
			if (this.plugin.bridgeStatus() !== "stopped") {
				void this.plugin.sendCommand({ cmd: "list_sessions" });
			}
		}, 12000);
	}

	async onClose(): Promise<void> {
		if (this.renderTimer != null) clearTimeout(this.renderTimer);
		if (this.sessionsRefreshTimer != null) clearTimeout(this.sessionsRefreshTimer);
		if (this.sessionsSyncTimer != null) clearInterval(this.sessionsSyncTimer);
		this.stopClock();
		document.removeEventListener("pointerdown", this.onDocPointerDown);
		this.plugin.unbindView(this);
	}

	/**
	 * Re-paint locale-dependent chrome after a language switch (settings tab →
	 * plugin.onLanguageChanged). Never touches conversation entries, so it is
	 * safe mid-turn; already-rendered messages keep their original language and
	 * anything rendered afterwards uses the new one.
	 */
	relocalize(): void {
		if (!this.headerEl) return; // view not built yet; onOpen will localize
		this.historyBtn.setAttribute("aria-label", tt("历史会话", "Session history"));
		this.newChatBtn.setAttribute("aria-label", tt("新会话", "New session"));
		this.newChatLabelEl.setText(tt("新会话", "New session"));
		this.historyTitleEl.setText(tt("历史会话", "Session history"));
		this.historyFootEl.setText(
			tt(
				"会话与 dsh web 共享同一存储，归档双向同步；同一会话请避免两端同时使用。",
				"Sessions share storage with dsh web, archiving syncs both ways; use one surface at a time.",
			),
		);
		this.inputEl.setAttribute(
			"placeholder",
			tt("向 DeepShian 描述你想完成的事情…", "Describe what you want DeepShian to accomplish…"),
		);
		for (const item of Array.from(this.modeMenuEl.children) as HTMLElement[]) {
			const value = item.getAttribute("data-value") as ChatMode | null;
			if (!value) continue;
			item.querySelector<HTMLElement>(".dshc-item-label")?.setText(modeMeta(value).label);
		}
		this.applyMode();
		this.renderHeaderTitle();
		this.renderSessions();
		this.renderStatus();
	}

	// ------------------------------------------------------------- external
	handleStatus(status: BridgeStatus, info?: string): void {
		if (status === "stopped") {
			this.abandonRunningTurn();
		}
		if (status === "stopped" && info) {
			this.showBanner(info);
		} else if (status === "ready") {
			this.hideBanner();
			this.renderModelFallback();
		}
		this.renderStatus(info);
	}

	handleEvent(event: DshEvent): void {
		switch (event.t) {
			case "turn_start":
				this.currentAssistant = this.pushAssistant();
				this.renderStatus();
				break;
			case "reasoning": {
				const cur = this.currentAssistant;
				if (!cur) break;
				cur.reasoning += event.delta;
				this.renderReasoning(cur);
				break;
			}
			case "text": {
				const cur = this.currentAssistant;
				if (!cur) break;
				cur.text += event.delta;
				this.scheduleRender(cur);
				break;
			}
			case "tool_use":
				this.addTool(
					event.callId ?? `tool-${this.entries.length}`,
					event.name ?? "(unknown)",
					event.input,
				);
				break;
			case "tool_result": {
				const cur = this.currentAssistant;
				const callId = event.callId ?? "";
				let tool =
					callId && cur ? cur.tools.find((x) => x.callId === callId && !x.done) : undefined;
				if (!tool && cur) tool = cur.tools.find((x) => !x.done);
				if (tool) this.fillTool(tool, event.output ?? "", event.isError === true);
				break;
			}
			case "usage": {
				const cur = this.currentAssistant;
				if (cur) {
					cur.usage = event.usage;
					this.renderUsage(cur);
				}
				break;
			}
			case "turn_end": {
				const cur = this.currentAssistant;
				if (cur) {
					if (event.reason === "error" || event.error) cur.error = event.error ?? event.reason;
					this.flushMarkdown(cur);
					this.renderUsage(cur);
					this.renderError(cur);
					this.finishAssistant(cur);
				}
				this.currentAssistant = null;
				this.renderStatus();
				this.scrollBottom();
				// Session titles are generated once turns complete — refresh lazily.
				this.scheduleSessionsRefresh(1500);
				break;
			}
			case "error":
				new Notice(`DSH: ${event.message}`);
				this.pushSystemNote(event.message);
				break;
			case "ready":
				this.activeSessionId = event.session ?? "";
				this.currentSessionTitle = "";
				this.renderModelFallback();
				this.renderHeaderTitle();
				// Pull persisted titles (incl. the fresh one) shortly after boot.
				this.scheduleSessionsRefresh(1200);
				// Per the "On open" setting, auto-resume the most recent conversation
				// for this vault once. An explicit "new chat" request suppresses it.
				if (this.skipNextResume) {
					this.skipNextResume = false;
				} else if (this.plugin.settings.onOpen === "resume") {
					this.pendingResume = true;
					void this.plugin.sendCommand({ cmd: "list_sessions" });
				}
				break;
			case "models":
				this.modelsCache = event.models;
				this.currentSelection = event.current;
				this.applyModels();
				break;
			case "sessions": {
				const archivedId = event.archived ?? "";
				this.sessionsCache = event.sessions;
				this.refreshCurrentTitle();
				this.renderSessions();
				if (archivedId) {
					if (archivedId === this.activeSessionId) {
						// dsh web parity: archiving the current selection clears it to
						// New Session; the bridge has already dropped that live agent.
						this.clearConversation(false);
						this.closeHistory();
					}
					new Notice(tt("会话已归档", "Session archived"));
				}
				if (this.pendingResume) {
					this.pendingResume = false;
					this.resumeNewest(event.sessions);
				}
				break;
			}
			case "session_created":
				// A fresh session was minted on the first message of a new chat —
				// adopt it so its generated title lands in the header.
				this.activeSessionId = event.id;
				this.currentSessionTitle = "";
				this.renderHeaderTitle();
				this.scheduleSessionsRefresh(1200);
				break;
			case "session_opened": {
				const opened = event.id === this.activeSessionId;
				this.activeSessionId = event.id;
				this.currentSelection = parseModelString(event.model);
				this.renderModelFallback();
				this.refreshCurrentTitle();
				this.scheduleSessionsRefresh(500);
				this.closeHistory();
				for (const row of Array.from(this.historyListEl.children) as HTMLElement[]) {
					row.querySelector<HTMLElement>(".dshc-history-row")?.removeClass("pending");
				}
				this.renderReplay(event.turns);
				if (!opened) {
					new Notice(
						tt("已打开历史会话（上下文完整恢复）", "Session resumed with full context"),
					);
				}
				break;
			}
			default:
				break;
		}
	}

	sendCurrentInput(): void {
		if (this.isBusy()) return;
		const text = this.inputEl.value.trim();
		if (!text) return;
		const entry: UserEntry = { kind: "user", text };
		this.entries.push(entry);
		this.appendUserBubble(entry);
		this.inputEl.value = "";
		this.autosize();
		this.renderStatus();
		if (!this.plugin.sendPrompt(text, this.mode)) {
			entry.text = `⚠️ ${tt("未发送（dsh 进程未运行）：", "Not sent (dsh process is not running): ")}${text}`;
			new Notice(tt("DSH 桥接未运行", "DSH bridge not running"));
		}
		this.scrollBottom();
	}

	startNewChat(): void {
		this.clearConversation(true);
		// Do not restart the bridge: that used to mint a new persisted session on
		// every click, polluting the shared history. The bridge now drops its live
		// agent and only creates a session when the first real message is sent.
		this.plugin.ensureBridge();
		void this.plugin.sendCommand({ cmd: "new_chat" });
	}

	/**
	 * Reset the sidebar conversation to the empty New Session state. `skip`
	 * suppresses the boot auto-resume — set when the user explicitly asked for
	 * a fresh chat, cleared when the archive flow (or anything else) forced the
	 * reset without a user intent to start over.
	 */
	private clearConversation(skip: boolean): void {
		this.entries = [];
		this.currentAssistant = null;
		this.stopClock();
		this.activeSessionId = "";
		this.currentSessionTitle = "";
		this.renderHeaderTitle();
		this.columnEl.empty();
		this.skipNextResume = skip;
		this.pendingResume = false;
	}

	/**
	 * Pick the session with the newest `updatedAt` for this vault and open it,
	 * implementing "On open → resume last conversation". Archived/deleted rows
	 * are already filtered out server-side, so the newest here is a live one.
	 */
	private resumeNewest(sessions: SessionSummary[]): void {
		let best: SessionSummary | null = null;
		for (const s of sessions) {
			if (s.id === this.activeSessionId) continue;
			if (best == null || (s.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = s;
		}
		const target = best ?? sessions[0] ?? null;
		if (!target) return;
		void this.plugin.sendCommand({ cmd: "open_session", id: target.id });
	}

	// ----------------------------------------------------------------- busy
	/** A turn is streaming or the bridge is still coming up. */
	private isBusy(): boolean {
		const status = this.plugin.bridgeStatus();
		return (
			this.currentAssistant !== null ||
			status === "running" ||
			status === "connecting"
		);
	}

	/**
	 * The dsh process died (or a new chat restarted the bridge) while a turn was
	 * streaming: finalize the open entry so its clock stops, tool cards leave
	 * the running state, and the send button unlocks for the next attempt.
	 */
	private abandonRunningTurn(): void {
		const cur = this.currentAssistant;
		if (!cur) return;
		for (const tool of cur.tools) {
			if (tool.done) continue;
			tool.done = true;
			tool.detailsEl?.setAttribute("data-state", "error");
			tool.stateEl?.setAttribute("data-state", "error");
			tool.summaryEl?.setText(tt("已停止", "stopped"));
		}
		cur.error ??= tt("回合被中断（dsh 已停止）", "turn interrupted (dsh stopped)");
		this.renderError(cur);
		this.finishAssistant(cur);
		this.currentAssistant = null;
	}

	// ----------------------------------------------------------------- dom
	private buildHeader(): void {
		this.headerEl = this.contentEl.createDiv({ cls: "dsh-header" });
		this.statusChip = this.headerEl.createSpan({ cls: "dsh-status", text: "stopped" });
		this.titleEl = this.headerEl.createSpan({
			cls: "dsh-title",
			text: tt("新对话", "New chat"),
		});

		// Session-history dropdown; lives inside .dsh-header (position:relative)
		// so it anchors right beneath the header instead of off-view.
		this.historyBtn = this.headerEl.createEl("button", {
			cls: "clickable-icon dsh-iconbtn",
			attr: { "aria-label": tt("历史会话", "Session history"), "aria-haspopup": "true" },
		});
		this.historyBtn.append(svgIcon(ICON_HISTORY));
		this.historyBtn.addEventListener("click", () => {
			if (this.historyPanelEl.hasAttribute("hidden")) this.openHistory();
			else this.closeHistory();
		});

		// Explicit labeled pill — unmistakable entry point for a fresh conversation.
		this.newChatBtn = this.headerEl.createEl("button", {
			cls: "dsh-newchat-btn",
			attr: { type: "button", "aria-label": tt("新会话", "New session") },
		});
		this.newChatBtn.createSpan({ cls: "dsh-newchat-icon" }).append(svgIcon(ICON_PLUS));
		this.newChatLabelEl = this.newChatBtn.createSpan({
			cls: "dsh-newchat-label",
			text: tt("新会话", "New session"),
		});
		this.newChatBtn.addEventListener("click", () => this.startNewChat());
	}

	/** Dropdown panel listing this workspace's persisted sessions. */
	private buildHistoryPanel(): void {
		this.historyPanelEl = this.headerEl.createDiv({
			cls: "dshc-history",
			attr: { hidden: "" },
		});
		this.historyTitleEl = this.historyPanelEl.createDiv({
			cls: "dshc-history-title",
			text: tt("历史会话", "Session history"),
		});
		this.historyListEl = this.historyPanelEl.createDiv({ cls: "dshc-history-list" });
		this.historyFootEl = this.historyPanelEl.createDiv({
			cls: "dshc-history-foot",
			text: tt(
				"会话与 dsh web 共享同一存储，归档双向同步；同一会话请避免两端同时使用。",
				"Sessions share storage with dsh web, archiving syncs both ways; use one surface at a time.",
			),
		});
	}

	private openHistory(): void {
		if (this.plugin.bridgeStatus() === "stopped") {
			new Notice(tt("DSH 未运行，无法读取历史会话", "DSH is not running; history unavailable"));
			return;
		}
		this.historyPanelEl.removeAttribute("hidden");
		this.renderSessions();
		void this.plugin.sendCommand({ cmd: "list_sessions" });
	}
	private closeHistory(): void {
		this.historyPanelEl.setAttribute("hidden", "");
	}

	/**
	 * Resolve the active session's title from the latest sessions payload and
	 * reflect it into the header caption (falls back to 新对话 until known).
	 */
	private refreshCurrentTitle(): void {
		const found = this.sessionsCache.find((s) => s.id === this.activeSessionId);
		const title = (found?.title ?? "").trim();
		if (title === this.currentSessionTitle) return;
		this.currentSessionTitle = title;
		this.renderHeaderTitle();
	}

	private renderHeaderTitle(): void {
		if (!this.titleEl) return;
		const text = this.currentSessionTitle || tt("新对话", "New chat");
		this.titleEl.setText(text);
		this.titleEl.setAttr("aria-label", tt(`当前会话：${text}`, `Current session: ${text}`));
	}

	/** One debounced list_sessions round-trip so header/history titles stay fresh. */
	private scheduleSessionsRefresh(delayMs: number): void {
		if (this.sessionsRefreshTimer != null) return;
		this.sessionsRefreshTimer = setTimeout(() => {
			this.sessionsRefreshTimer = null;
			void this.plugin.sendCommand({ cmd: "list_sessions" });
		}, delayMs);
	}

	/** Paint the cached session rows (newest first, active one marked). */
	private renderSessions(): void {
		this.historyListEl.empty();
		if (this.sessionsCache.length === 0) {
			this.historyListEl.createDiv({
				cls: "dshc-history-empty",
				text: tt("本工作区暂无历史会话", "No sessions in this workspace yet"),
			});
			return;
		}
		for (const s of this.sessionsCache) {
			const entry = this.historyListEl.createDiv({ cls: "dshc-history-entry" });
			const row = entry.createEl("button", {
				cls: "dshc-history-row",
				attr: { type: "button", "data-session": s.id },
			});
			row.toggleClass("active", s.id === this.activeSessionId);
			const textCol = row.createDiv({ cls: "dshc-history-text" });
			textCol.createDiv({ cls: "dshc-history-name", text: s.title || tt("未命名会话", "Untitled session") });
			const metaParts: string[] = [];
			if (s.live) metaParts.push(tt("进行中", "live"));
			if (s.updatedAt != null && Number(s.updatedAt) > 0) {
				metaParts.push(formatTime(Number(s.updatedAt)));
			}
			if (metaParts.length > 0) {
				textCol.createDiv({ cls: "dshc-history-meta", text: metaParts.join(" · ") });
			}
			row.addEventListener("click", () => {
				if (s.id === this.activeSessionId) {
					this.closeHistory();
					return;
				}
				for (const other of Array.from(this.historyListEl.children) as HTMLElement[]) {
					other.querySelector<HTMLElement>(".dshc-history-row")?.removeClass("pending");
				}
				row.addClass("pending");
				void this.plugin.sendCommand({ cmd: "open_session", id: s.id });
			});

			// Archive action, hover-revealed like a dsh web row affordance. One
			// click archives — no confirmation, matching the web surface — and the
			// bridge echoes a fresh sessions payload that drops the row here while
			// dsh web (same archive set) hides it on its next listing.
			const archive = entry.createEl("button", {
				cls: "dshc-history-archive",
				attr: {
					type: "button",
					"aria-label": tt("归档会话", "Archive session"),
					title: tt("归档会话（与 dsh web 同步）", "Archive session (synced with dsh web)"),
				},
			});
			archive.append(svgIcon(ICON_ARCHIVE));
			// Never archive the live session mid-turn: the bridge would reject the
			// switch anyway; disabling the affordance is the honest state.
			archive.disabled = s.id === this.activeSessionId && this.isBusy();
			archive.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.archiveSession(s, entry);
			});
		}
	}

	/** Request one session's archival; the echoed sessions payload does the rest. */
	private archiveSession(s: SessionSummary, entry: HTMLElement): void {
		if (this.plugin.bridgeStatus() === "stopped") {
			new Notice(tt("DSH 未运行，无法归档会话", "DSH is not running; archive unavailable"));
			return;
		}
		entry.addClass("archiving"); // optimistic fade until the payload round-trips
		if (!this.plugin.sendCommand({ cmd: "archive_session", id: s.id })) {
			entry.removeClass("archiving");
			new Notice(tt("DSH 未运行，无法归档会话", "DSH is not running; archive unavailable"));
		}
	}

	private buildComposer(): void {
		const composer = this.contentEl.createDiv({ cls: "dsh-composer" });
		const card = composer.createDiv({ cls: "dshc-card" });

		// Owns the scroll once the textarea passes --dsh-input-max-height, so the
		// textarea itself never shows a scrollbar (mirrors the dsh web composer).
		const inputScroll = card.createDiv({ cls: "dshc-inputscroll" });
		this.inputEl = inputScroll.createEl("textarea", {
			cls: "dsh-input",
			// placeholder goes through the attr channel so it is guaranteed to
			// reach the DOM even if a host helper drops the top-level option.
			attr: {
				placeholder: tt(
					"向 DeepShian 描述你想完成的事情…",
					"Describe what you want DeepShian to accomplish…",
				),
			},
		});
		this.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
			if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing) {
				evt.preventDefault();
				this.sendCurrentInput();
			}
		});
		this.inputEl.addEventListener("input", () => {
			this.autosize();
			this.renderStatus();
		});

		const row = card.createDiv({ cls: "dshc-row" });

		// Access-mode select, bottom-left of the composer card (dsh web style).
		const modewrap = row.createDiv({ cls: "dshc-modewrap" });
		this.modeTriggerBtn = modewrap.createEl("button", { cls: "dshc-mode-trigger" });
		this.modeTriggerIcon = this.modeTriggerBtn.createSpan({ cls: "dshc-trigger-icon" });
		this.modeTriggerLabel = this.modeTriggerBtn.createSpan({ cls: "dshc-trigger-label" });
		this.modeTriggerBtn
			.createSpan({ cls: "dshc-trigger-chevron" })
			.append(svgIcon(ICON_CHEVRON));
		this.modeMenuEl = modewrap.createDiv({ cls: "dshc-menu", attr: { hidden: "" } });
		for (const value of ["readonly", "writable"] as ChatMode[]) {
			const item = this.modeMenuEl.createEl("button", {
				cls: "dshc-menu-item",
				attr: { type: "button", role: "option", "data-value": value },
			});
			item.createSpan({ cls: "dshc-item-icon" }).append(
				svgIcon(value === "readonly" ? ICON_MODE_READONLY : ICON_MODE_WRITE),
			);
			item.createSpan({ cls: "dshc-item-label", text: modeMeta(value).label });
			item.createSpan({ cls: "dshc-item-check" }).append(svgIcon(ICON_CHECK));
			item.addEventListener("click", () => {
				if (this.mode !== value) {
					this.mode = value;
					this.applyMode();
				}
				this.closeModeMenu();
			});
		}
		this.modeTriggerBtn.addEventListener("click", () => {
			if (this.modeMenuEl.hasAttribute("hidden")) this.openModeMenu();
			else this.closeModeMenu();
		});
		this.applyMode();

		// Model selector, immediately left of the send button (dsh web style).
		this.modelWrapEl = row.createDiv({ cls: "dshc-modewrap dshc-modelwrap" });
		this.modelBtn = this.modelWrapEl.createEl("button", { cls: "dshc-mode-trigger" });
		this.modelBtn.createSpan({ cls: "dshc-trigger-icon" }).append(svgIcon(ICON_SPARKLE));
		this.modelBtnLabel = this.modelBtn.createSpan({ cls: "dshc-trigger-label" });
		this.modelBtn.createSpan({ cls: "dshc-trigger-chevron" }).append(svgIcon(ICON_CHEVRON));
		this.modelMenuEl = this.modelWrapEl.createDiv({ cls: "dshc-menu", attr: { hidden: "" } });
		this.modelBtn.addEventListener("click", () => {
			if (this.plugin.bridgeStatus() === "stopped") {
				new Notice(tt("DSH 未运行", "DSH is not running"));
				return;
			}
			if (this.modelMenuEl.hasAttribute("hidden")) {
				// Refresh the catalog every open; applyModels repaints live if stale.
				void this.plugin.sendCommand({ cmd: "list_models" });
				this.openModelMenu();
			} else {
				this.closeModelMenu();
			}
		});
		this.renderModelFallback();

		row.createDiv({ cls: "dshc-rowspacer" });

		// Primary round button; the icon flips to the stop glyph while running.
		this.sendBtn = row.createEl("button", { cls: "dshc-send", attr: { type: "button" } });
		this.sendBtn.createSpan({ cls: "dshc-send-icon" }).append(svgIcon(ICON_SEND));
		this.sendBtn.createSpan({ cls: "dshc-stop-icon" }).append(svgIcon(ICON_STOP));
		this.sendBtn.addEventListener("click", () => {
			const running = this.plugin.bridgeStatus() === "running" || this.currentAssistant !== null;
			if (running) {
				void this.plugin.sendCommand({ cmd: "stop" });
				new Notice(tt("已请求停止生成", "Stop requested"));
			} else {
				this.sendCurrentInput();
			}
		});
	}

	/** Reflect the active mode into trigger label/icon/menu selection state. */
	private applyMode(): void {
		const meta = modeMeta(this.mode);
		this.modeTriggerLabel.setText(meta.label);
		this.modeTriggerIcon.replaceChildren(
			svgIcon(this.mode === "readonly" ? ICON_MODE_READONLY : ICON_MODE_WRITE),
		);
		this.modeTriggerBtn.setAttribute(
			"aria-label",
			`${tt("访问模式，当前：", "Access mode, current: ")}${meta.label}`,
		);
		this.modeTriggerBtn.setAttribute("title", meta.title);
		for (const item of Array.from(this.modeMenuEl.children) as HTMLElement[]) {
			const selected = item.getAttribute("data-value") === this.mode;
			item.toggleClass("selected", selected);
			item.setAttribute("aria-selected", selected ? "true" : "false");
		}
	}

	private openModeMenu(): void {
		this.modeMenuEl.removeAttribute("hidden");
		this.modeTriggerBtn.addClass("open");
	}
	private closeModeMenu(): void {
		this.modeMenuEl.setAttribute("hidden", "");
		this.modeTriggerBtn.removeClass("open");
	}
	private openModelMenu(): void {
		this.modelMenuEl.removeAttribute("hidden");
		this.modelBtn.addClass("open");
	}
	private closeModelMenu(): void {
		this.modelMenuEl.setAttribute("hidden", "");
		this.modelBtn.removeClass("open");
	}

	/** Fallback pill label before the first ModelsEvent arrives. */
	private renderModelFallback(): void {
		const raw = this.plugin.bridge.model;
		const model = raw.includes("/") ? (raw.split("/")[1] ?? raw) : raw || "…";
		this.modelBtnLabel.setText(model);
	}

	/** Rebuild the model menu from the latest ModelsEvent payload. */
	private applyModels(): void {
		if (!this.currentSelection) return;
		const { provider, model } = this.currentSelection;
		const exact = this.modelsCache.find((m) => m.provider === provider && m.id === model);
		this.modelBtnLabel.setText(exact?.name ?? model);

		this.modelMenuEl.empty();
		if (this.modelsCache.length === 0) {
			// Catalog request still in flight; keep the menu informative meanwhile.
			this.modelMenuEl.createDiv({
				cls: "dshc-menu-empty",
				text: tt("模型目录加载中…", "Loading model catalog…"),
			});
			return;
		}
		const multiProvider =
			new Set(this.modelsCache.map((m) => m.provider)).size > 1;
		for (const m of this.modelsCache) {
			const item = this.modelMenuEl.createEl("button", {
				cls: "dshc-menu-item",
				attr: {
					type: "button",
					role: "option",
					"data-provider": m.provider,
					"data-model": m.id,
				},
			});
			const textCol = item.createDiv({ cls: "dshc-model-text" });
			textCol.createDiv({ cls: "dshc-model-name", text: m.name });
			if (multiProvider) {
				textCol.createDiv({ cls: "dshc-model-provider", text: m.provider });
			}
			item.createSpan({ cls: "dshc-item-check" }).append(svgIcon(ICON_CHECK));
			const selected = m.provider === provider && m.id === model;
			item.toggleClass("selected", selected);
			item.setAttribute("aria-selected", selected ? "true" : "false");
			item.addEventListener("click", () => {
				if (!selected) {
					void this.plugin.sendCommand({
						cmd: "set_model",
						provider: m.provider,
						model: m.id,
					});
					// optimistic until the authoritative ModelsEvent round-trips
					this.modelBtnLabel.setText(m.name);
				}
				this.closeModelMenu();
			});
		}
	}

	/** Render a restored session's folded turns into finished cards. */
	private renderReplay(turns: ReplayTurn[]): void {
		this.columnEl.empty();
		this.entries = [];
		for (const turn of turns) {
			if (turn.user && turn.user.trim() !== "") {
				this.appendUserBubble({ kind: "user", text: turn.user });
			}
			if (
				(turn.assistant && turn.assistant.trim() !== "") ||
				(turn.tools != null && turn.tools.length > 0)
			) {
				const entry = this.pushAssistant();
				this.finishAssistant(entry); // no shimmer / clock for replayed turns
				entry.text = turn.assistant ?? "";
				if (entry.text.trim() !== "") this.flushMarkdown(entry);
				for (const tool of turn.tools ?? []) {
					const details = this.buildToolCard(entry.toolsEl ?? this.columnEl, tool.name, tool.input);
					details.setAttribute("data-state", tool.isError ? "error" : "ok");
					details.querySelector(".dshc-dot")?.setAttribute("data-state", tool.isError ? "error" : "ok");
					details.querySelector<HTMLElement>(".dshc-sum")?.setText(
						tool.isError
							? tt("失败", "failed")
							: tool.output
								? previewLine(tool.output)
								: tt("完成", "done"),
					);
					const pre = details.querySelector<HTMLPreElement>(".dshc-output");
					if (pre && tool.output) {
						pre.removeAttribute("style");
						pre.textContent = tool.output;
					}
				}
				if (turn.usage && Object.keys(turn.usage).length > 0) {
					entry.usage = turn.usage;
					this.renderUsage(entry);
				}
			}
		}
		this.scrollBottom();
	}

	private onDocPointerDown = (evt: PointerEvent): void => {
		const target = evt.target as Node | null;
		if (!target) return;
		if (!this.modeMenuEl.hasAttribute("hidden")) {
			const wrap = this.modeMenuEl.parentElement;
			if (!(wrap && wrap.contains(target))) this.closeModeMenu();
		}
		if (!this.modelMenuEl.hasAttribute("hidden")) {
			const wrap = this.modelMenuEl.parentElement;
			if (!(wrap && wrap.contains(target)) && !this.modelBtn.contains(target)) {
				this.closeModelMenu();
			}
		}
		if (!this.historyPanelEl.hasAttribute("hidden")) {
			if (
				!this.historyPanelEl.contains(target) &&
				!this.historyBtn.contains(target)
			) {
				this.closeHistory();
			}
		}
	};

	/**
	 * The textarea owns no scrollbar: it always grows to fit its content and the
	 * wrapper (.dshc-inputscroll) scrolls once --dsh-input-max-height is hit —
	 * exactly how the dsh web composer behaves.
	 */
	private autosize(): void {
		const ta = this.inputEl;
		// No CSS `height` rule on .dsh-input, so removing the inline height is
		// exactly `height: auto` — the collapsed state the measure needs.
		ta.style.removeProperty("height");
		ta.style.height = `${ta.scrollHeight}px`;
	}

	private appendUserBubble(entry: UserEntry): void {
		const row = this.columnEl.createDiv({ cls: "dshc-userrow" });
		const bubble = row.createDiv({ cls: "dshc-bubble" });
		bubble.setText(entry.text);
		this.buildCopyButton(row, () => entry.text, copyLabel());
		this.scrollBottom();
	}

	// ------------------------------------------------------------ clipboard
	/** Ghost copy button (optional label; flashes "Copied" on success). */
	private buildCopyButton(
		container: HTMLElement,
		getText: () => string,
		label?: string,
	): HTMLButtonElement {
		const btn = container.createEl("button", {
			cls: "dshc-copybtn",
			attr: {
				type: "button",
				"aria-label": label ?? tt("复制消息", "Copy message"),
				title: label ?? tt("复制消息", "Copy message"),
			},
		});
		btn.createSpan({ cls: "dshc-copy-icon" }).append(svgIcon(ICON_COPY));
		if (label !== undefined) {
			btn.createSpan({ cls: "dshc-copy-label", text: copyLabel() });
		}
		btn.addEventListener("click", () => {
			void this.handleCopy(btn, getText());
		});
		return btn;
	}

	private async handleCopy(btn: HTMLButtonElement, text: string): Promise<void> {
		// Ignore re-clicks while the success flash is still showing.
		if (btn.hasClass("copied") || !text) return;
		const ok = await copyText(text);
		if (!ok) {
			new Notice(tt("复制失败", "Copy failed"));
			return;
		}
		const label = btn.querySelector<HTMLElement>(".dshc-copy-label");
		btn.addClass("copied");
		if (label) label.setText(tt("已复制", "Copied"));
		window.setTimeout(() => {
			btn.removeClass("copied");
			if (label) label.setText(copyLabel());
		}, 1500);
	}

	// ------------------------------------------------------- assistant flow
	private pushAssistant(): AssistantEntry {
		const entry: AssistantEntry = {
			kind: "assistant",
			text: "",
			reasoning: "",
			tools: [],
		};
		const root = this.columnEl.createDiv({ cls: "dshc-item" });
		entry.rootEl = root;

		entry.statusEl = root.createDiv({ cls: "dshc-turnstatus" });
		entry.statusEl.createSpan({
			cls: "dshc-turnstatus-text",
			text: tt("正在思考…", "Thinking…"),
		});
		entry.clockEl = entry.statusEl.createSpan({
			cls: "dshc-turnstatus-clock",
			text: "0:00",
		});
		this.startClock(entry);

		entry.reasoningEl = root.createEl("details", {
			cls: "dshc-disc dshc-reasoning",
			attr: { style: "display:none", "data-state": "running" },
		});
		const rrow = entry.reasoningEl.createEl("summary", { cls: "dshc-discrow" });
		const rleading = rrow.createSpan({ cls: "dshc-leading" });
		rleading.createSpan({ cls: "dshc-ico" }).append(svgIcon(ICON_THINK));
		rleading.createSpan({ cls: "dshc-chev" }).append(svgIcon(ICON_CHEVRON));
		rrow.createSpan({ cls: "dshc-title", text: "Think" });
		rrow.createSpan({ cls: "dshc-sep" });
		entry.reasoningSumEl = rrow.createSpan({ cls: "dshc-sum" });
		entry.reasoningBodyEl = entry.reasoningEl.createDiv({ cls: "dshc-thinkbody" });

		entry.toolsEl = root.createDiv({ cls: "dshc-tools" });
		entry.textEl = root.createDiv({ cls: "dshc-md" });
		entry.errorEl = root.createDiv({ cls: "dshc-error" });
		// Message footer: copy action + token usage, left-aligned; stays hidden
		// (.is-pending) until the turn finishes, then revealed by finishAssistant.
		const foot = root.createDiv({ cls: "dshc-foot is-pending" });
		entry.footEl = foot;
		this.buildCopyButton(foot, () => {
			const text = entry.text.trim();
			return text !== "" ? text : (entry.error ?? "");
		}, copyLabel());
		entry.usageEl = foot.createDiv({ cls: "dshc-usage" });

		this.entries.push(entry);
		this.scrollBottom();
		return entry;
	}

	private startClock(entry: AssistantEntry): void {
		this.turnStartedAt = Date.now();
		this.stopClock();
		this.clockTimer = setInterval(() => {
			const sec = Math.floor((Date.now() - this.turnStartedAt) / 1000);
			entry.clockEl?.setText(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`);
		}, 1000);
	}

	private stopClock(): void {
		if (this.clockTimer != null) {
			clearInterval(this.clockTimer);
			this.clockTimer = null;
		}
	}

	private finishAssistant(entry: AssistantEntry): void {
		this.stopClock();
		entry.footEl?.removeClass("is-pending");
		entry.statusEl?.remove();
		entry.statusEl = undefined;
		entry.clockEl = undefined;
		entry.reasoningEl?.setAttribute("data-state", "ok");
		if (entry.reasoningSumEl) {
			const firstLine = entry.reasoning.slice(0, Math.max(0, entry.reasoning.indexOf("\n")));
			entry.reasoningSumEl.setText(previewLine(firstLine));
		}
	}

	private scheduleRender(entry: AssistantEntry): void {
		if (this.renderTimer != null) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = null;
			this.flushMarkdown(entry);
			this.scrollBottom();
		}, RENDER_THROTTLE_MS);
	}

	/** Re-render one assistant bubble's markdown into a fresh container. */
	private flushMarkdown(entry: AssistantEntry): void {
		if (!entry.rootEl || !entry.textEl) return;
		if (entry.text.length === 0) return;
		const frag = createDiv();
		void MarkdownRenderer.render(this.app, entry.text, frag, "", this);
		entry.textEl.replaceChildren(...Array.from(frag.childNodes));
	}

	private renderReasoning(entry: AssistantEntry): void {
		const el = entry.reasoningEl;
		const body = entry.reasoningBodyEl;
		const sum = entry.reasoningSumEl;
		if (!el || !body || !sum) return;
		if (entry.reasoning.length > 0) el.removeAttribute("style");
		body.textContent = entry.reasoning;
		// dsh shows the latest line as the collapsed summary while streaming.
		const visible = entry.reasoning.trimEnd();
		const nl = visible.lastIndexOf("\n");
		sum.setText(nl === -1 ? visible : visible.slice(nl + 1));
		this.scrollBottom();
	}

	// --------------------------------------------------------------- tools
	private addTool(callId: string, name: string, input: unknown): void {
		const cur = this.currentAssistant ?? this.pushAssistant();
		const details = this.buildToolCard(cur.toolsEl ?? this.columnEl, name, input);
		cur.tools.push({
			callId,
			name,
			input,
			done: false,
			detailsEl: details,
			stateEl: details.querySelector<HTMLElement>(".dshc-dot") ?? undefined,
			summaryEl: details.querySelector<HTMLElement>(".dshc-sum") ?? undefined,
			outputEl: details.querySelector<HTMLPreElement>(".dshc-output") ?? undefined,
		});
		this.scrollBottom();
	}

	/** Build one dsh-style disclosure-row tool card inside `container`. */
	private buildToolCard(
		container: HTMLElement,
		name: string,
		input: unknown,
	): HTMLDetailsElement {
		const details = container.createEl("details", {
			cls: "dshc-disc dshc-tool",
			attr: { "data-state": "running" },
		});
		const row = details.createEl("summary", { cls: "dshc-discrow" });
		const leading = row.createSpan({ cls: "dshc-leading" });
		leading.createSpan({ cls: "dshc-ico" }).append(svgIcon(ICON_COMMAND));
		leading.createSpan({ cls: "dshc-chev" }).append(svgIcon(ICON_CHEVRON));
		row.createSpan({ cls: "dshc-dot" });
		row.createSpan({ cls: "dshc-title mono", text: name });
		row.createSpan({ cls: "dshc-sep" });
		row.createSpan({ cls: "dshc-sum", text: summarizeInput(input) });
		const body = details.createDiv({ cls: "dshc-toolbody" });
		if (input != null && Object.keys(input as object).length > 0) {
			body.createEl("pre", {
				cls: "dshc-pre",
				text: JSON.stringify(input, null, 2),
			});
		}
		body.createEl("pre", {
			cls: "dshc-pre dshc-output",
			attr: { style: "display:none" },
		});
		return details;
	}

	private fillTool(tool: ToolEntry, output: string, isError: boolean): void {
		tool.output = output;
		tool.isError = isError;
		tool.done = true;
		const state = isError ? "error" : "ok";
		tool.detailsEl?.setAttribute("data-state", state);
		tool.stateEl?.setAttribute("data-state", state);
		tool.summaryEl?.setText(
			isError ? tt("失败", "failed") : output ? previewLine(output) : tt("完成", "done"),
		);
		if (tool.outputEl && output) {
			tool.outputEl.removeAttribute("style");
			tool.outputEl.textContent = output;
		}
		this.scrollBottom();
	}

	private renderUsage(entry: AssistantEntry): void {
		if (!entry.usageEl || !entry.usage) return;
		const u = entry.usage;
		const parts: string[] = [];
		if (u.inputTokens != null) parts.push(`in ${u.inputTokens}`);
		if (u.outputTokens != null) parts.push(`out ${u.outputTokens}`);
		if (u.cacheReadTokens != null) parts.push(`cache ${u.cacheReadTokens}`);
		entry.usageEl.setText(parts.join(" · "));
	}

	private renderError(entry: AssistantEntry): void {
		if (!entry.errorEl || !entry.error) return;
		entry.errorEl.empty();
		entry.errorEl.createSpan({ cls: "dshc-error-dot" });
		entry.errorEl.createSpan({ cls: "dshc-error-msg", text: entry.error });
	}

	private pushSystemNote(message: string): void {
		const note = this.columnEl.createDiv({ cls: "dsh-system" });
		note.setText(message);
		this.scrollBottom();
	}

	private renderStatus(info?: string): void {
		const status = this.plugin.bridgeStatus();
		// The chip is a pure status word now; the header title carries the identity.
		this.statusChip.setText(statusText(status));
		this.statusChip.setAttr("data-status", status);

		const running = status === "running" || this.currentAssistant !== null;
		const connecting = status === "connecting";
		// While a turn runs the button stays enabled and acts as a red Stop; only
		// the pre-boot "connecting" state locks it out.
		// Disabled while connecting and whenever there is nothing to send —
		// except while a turn runs, where the button acts as Stop.
		const inputEmpty = this.inputEl ? this.inputEl.value.trim() === "" : true;
		this.sendBtn.disabled = connecting || (!running && inputEmpty);
		this.sendBtn.toggleClass("is-running", running);
		this.sendBtn.setAttribute(
			"aria-label",
			running
				? tt("停止生成", "Stop generating")
				: tt("发送消息", "Send message"),
		);
		this.sendBtn.setAttribute(
			"title",
			running
				? tt("点击停止当前生成", "Click to stop the current generation")
				: tt("发送消息", "Send message"),
		);

		const alive = status !== "stopped" && status !== "connecting";
		if (this.historyBtn) this.historyBtn.disabled = !alive;
		if (this.modelBtn) this.modelBtn.disabled = !alive;
	}

	private scrollBottom(): void {
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	showBanner(info: string): void {
		if (!this.bannerEl) return;
		this.bannerEl.setText(`⚠️ ${tt("dsh 已停止：", "dsh stopped: ")}${info}`);
		this.bannerEl.removeClass("is-hidden");
	}
	private hideBanner(): void {
		if (!this.bannerEl) return;
		this.bannerEl.addClass("is-hidden");
	}
}

/** One-line human preview used by tool summaries and reasoning titles. */
function previewLine(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

/** One-line human preview of a tool call's arguments. */
function summarizeInput(input: unknown): string {
	if (input == null || typeof input !== "object") return "";
	const keys = ["command", "file_path", "path", "query", "pattern", "url", "prompt", "skill"];
	for (const k of keys) {
		const v = (input as Record<string, unknown>)[k];
		if (typeof v === "string" && v.trim() !== "") return previewLine(v);
	}
	try {
		return previewLine(JSON.stringify(input));
	} catch {
		return "";
	}
}

/** Split a bridge "provider/model" display string back into its selection. */
function parseModelString(raw: string): ModelSelection | null {
	const slash = raw.indexOf("/");
	if (slash <= 0) return null;
	return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
}

/** Locale time-of-day/date formatting for history rows. */
function formatTime(ms: number): string {
	try {
		return new Date(ms).toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return String(ms);
	}
}

// ------------------------------------------------------------ clipboard io
/** Write text to the system clipboard; falls back to a hidden textarea copy. */
async function copyText(text: string): Promise<boolean> {
	if (!text) return false;
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Clipboard API can reject when the window lacks focus; fall back to the
		// legacy execCommand path, which works there.
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.addClass("dsh-clipboard-ghost");
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	} catch {
		return false;
	}
}
