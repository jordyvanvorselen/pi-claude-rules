import type { Settings } from "./config.ts";
import type { Rule } from "./rules.ts";

export const SECTION_HEADING = "## Project rules";

export function isInlined(rule: Rule, settings: Settings): boolean {
	return settings.ruleLoading === "eager" || (settings.ruleLoading === "hybrid" && rule.mode === "unscoped") || rule.mode === "always" || (rule.mode === "unscoped" && settings.unscopedRules === "inject");
}

export function scopeLabel(rule: Rule): string {
	if (rule.mode === "always") return "always";
	if (rule.globs.length === 0) return "any task";
	return rule.globs.join(", ");
}

function listLine(rule: Rule): string {
	const scope = rule.mode === "scoped" ? `applies to: ${rule.globs.join(", ")}` : "applies to any task";
	return `- ${rule.title} (${rule.displayPath}). ${scope}.`;
}

function sourceOf(rule: Rule): string {
	const idx = rule.displayPath.lastIndexOf("/");
	return idx === -1 ? "." : rule.displayPath.slice(0, idx);
}

function renderEager(rules: readonly Rule[]): string {
	const groups = new Map<string, Rule[]>();
	for (const rule of rules) {
		const group = groups.get(sourceOf(rule)) ?? [];
		group.push(rule);
		groups.set(sourceOf(rule), group);
	}
	const parts: string[] = [SECTION_HEADING, "", "All discovered project rules are loaded below before the first tool call. Follow the rule whose scope matches the file you are working on.", "", "### Loaded rule bodies", ""];
	for (const [source, sourceRules] of groups) {
		parts.push(`#### ${source}`, "");
		for (const rule of sourceRules) {
			parts.push(`##### ${rule.title} (${rule.displayPath})`, `Scope: ${rule.mode === "scoped" ? rule.globs.join(", ") : "any task"}`, "", rule.body, "");
		}
	}
	return parts.join("\n").trimEnd();
}

export function renderSection(rules: readonly Rule[], settings: Settings): string {
	if (rules.length === 0) return "";
	if (settings.ruleLoading === "eager") return renderEager(rules);
	const inlined = rules.filter((rule) => isInlined(rule, settings));
	const listed = rules.filter((rule) => !isInlined(rule, settings));
	const parts: string[] = [SECTION_HEADING, ""];
	parts.push(
		settings.ruleLoading === "hybrid"
			? "This project ships rule files (Claude Code style). Unscoped and always-apply rules are loaded globally. When a read touches a matching path, its scoped rules are included in the read result before the next response; mutations are blocked until those rules have been received."
			: "This project ships rule files (Claude Code style). Path-scoped rules are injected into the conversation automatically when you read, write, or edit a matching path. When you plan work inside a rule's scope, read the rule file first.",
	);
	if (inlined.length > 0) {
		parts.push("", "### Rules that always apply", "");
		for (const rule of inlined) parts.push(`#### ${rule.title} (${rule.displayPath})`, "", rule.body, "");
	}
	if (listed.length > 0) {
		parts.push("", "### Available rules", "");
		for (const rule of listed) parts.push(listLine(rule));
	}
	return parts.join("\n").trimEnd();
}

export function renderActivation(rule: Rule, touchedPath: string): string {
	const scope = rule.globs.join(", ");
	return [
		`Project rule activated: ${rule.title} (${rule.displayPath}).`,
		`Scope: ${scope}. Triggered by ${touchedPath}. Follow this rule for all work in its scope from now on.`,
		"",
		rule.body,
	].join("\n");
}
