/**
 * Plugin-wide zh/en localization.
 *
 * The effective language resolves once per load from the plugin's `language`
 * setting: "auto" follows the Obsidian UI language (any `zh*` locale → Chinese,
 * everything else → English); "zh"/"en" force one. Every user-facing string is
 * written as a `tt(chinese, english)` pair evaluated at render time, so a
 * language switch only needs a re-render (settings tab re-renders itself; the
 * chat view re-paints its chrome via `relocalize()`).
 */
export type Locale = "zh" | "en";
export type LanguageSetting = "auto" | Locale;

// Obsidian exposes Moment as a global; only the locale id is needed here.
declare const moment: { locale(): string };

/** Obsidian UI locale folded to our two locales: zh* → "zh", else "en". */
export function obsidianLocale(): Locale {
	try {
		return moment.locale().toLowerCase().startsWith("zh") ? "zh" : "en";
	} catch {
		return "en";
	}
}

/** Locale currently in force (set by applyLanguageSetting at load/switch). */
let current: Locale = "en";

/** Resolve a stored setting to its effective locale. */
export function effectiveLocale(setting: LanguageSetting): Locale {
	return setting === "auto" ? obsidianLocale() : setting;
}

/** Apply the stored language setting (call after load and on every change). */
export function applyLanguageSetting(setting: LanguageSetting): void {
	current = effectiveLocale(setting);
}

/** The locale in force right now. */
export function currentLocale(): Locale {
	return current;
}

/**
 * Pick the active side of a zh/en string pair. Named `tt` at import sites to
 * match the historical helper in chat-view.ts.
 */
export function t(zh: string, en: string): string {
	return current === "zh" ? zh : en;
}
