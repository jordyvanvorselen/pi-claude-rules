import type { Settings } from "./config.ts";
import type { Rule } from "./rules.ts";

export const SECTION_HEADING = "## Project rules";

export function isInlined(rule: Rule, settings: Settings): boolean {
	return rule.mode === "always" || (rule.mode === "unscoped" && settings.unscopedRules === "inject");
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

export function renderSection(rules: readonly Rule[], settings: Settings): string {
	if (rules.length === 0) return "";
	const inlined = rules.filter((rule) => isInlined(rule, settings));
	const listed = rules.filter((rule) => !isInlined(rule, settings));
	const parts: string[] = [SECTION_HEADING, ""];
	parts.push(
		"This project ships rule files (Claude Code style). Path-scoped rules are injected into the conversation automatically the first time you read, write, or edit a matching file. When you plan work inside a rule's scope, read the rule file first.",
	);
	if (inlined.length > 0) {
		parts.push("", "### Rules that always apply", "");
		for (const rule of inlined) {
			parts.push(`#### ${rule.title} (${rule.displayPath})`, "", rule.body, "");
		}
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
