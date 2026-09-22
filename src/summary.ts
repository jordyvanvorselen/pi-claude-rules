import type { Settings } from "./config.ts";
import { isInlined, scopeLabel } from "./prompt.ts";
import type { Rule } from "./rules.ts";

export type ModeLabel = "always" | "on match" | "listed";

export interface SummaryRule {
	name: string;
	mode: ModeLabel;
	scope: string;
	path: string;
	description?: string;
	warnings?: string[];
}

export interface SummaryGroup {
	source: string;
	rules: SummaryRule[];
}

export interface RuleSummary {
	kind: "summary";
	total: number;
	always: number;
	scoped: number;
	listed: number;
	groups: SummaryGroup[];
}

export interface Paint {
	heading: (text: string) => string;
	accent: (text: string) => string;
	dim: (text: string) => string;
}

export const PLAIN: Paint = { heading: (t) => t, accent: (t) => t, dim: (t) => t };

export function modeLabel(rule: Rule, settings: Settings): ModeLabel {
	if (isInlined(rule, settings)) return "always";
	return rule.mode === "scoped" ? "on match" : "listed";
}

function sourceOf(rule: Rule): string {
	const idx = rule.displayPath.lastIndexOf("/");
	return idx === -1 ? "." : rule.displayPath.slice(0, idx);
}

export function buildSummary(rules: readonly Rule[], settings: Settings): RuleSummary {
	const groups = new Map<string, SummaryRule[]>();
	let always = 0;
	let scoped = 0;
	for (const rule of rules) {
		const mode = modeLabel(rule, settings);
		if (mode === "always") always++;
		else if (mode === "on match") scoped++;
		const entry: SummaryRule = { name: rule.name, mode, scope: scopeLabel(rule), path: rule.displayPath };
		if (rule.description) entry.description = rule.description;
		if (rule.warnings.length > 0) entry.warnings = rule.warnings;
		const list = groups.get(sourceOf(rule)) ?? [];
		list.push(entry);
		groups.set(sourceOf(rule), list);
	}
	return {
		kind: "summary",
		total: rules.length,
		always,
		scoped,
		listed: rules.length - always - scoped,
		groups: [...groups.entries()].map(([source, list]) => ({ source, rules: list })),
	};
}

export function countsLine(summary: RuleSummary): string {
	const noun = summary.total === 1 ? "rule" : "rules";
	return `${summary.total} ${noun}: ${summary.always} always, ${summary.scoped} path-scoped, ${summary.listed} listed`;
}

export function compactNames(summary: RuleSummary): string {
	return summary.groups
		.flatMap((g) => g.rules.map((r) => r.name))
		.sort((a, b) => a.localeCompare(b))
		.join(", ");
}

export interface RenderOptions {
	expanded: boolean;
	activated?: ReadonlySet<string>;
	details?: boolean;
}

export function renderSummary(summary: RuleSummary, paint: Paint, options: RenderOptions): string {
	const lines: string[] = [paint.heading("[Claude rules]")];
	if (summary.total === 0) {
		lines.push(paint.dim("  no rules found"));
		return lines.join("\n");
	}
	if (!options.expanded) {
		lines.push(paint.dim(`  ${compactNames(summary)}`));
		lines.push(paint.dim(`  ${countsLine(summary)}`));
		return lines.join("\n");
	}
	lines.push(paint.dim(`  ${countsLine(summary)}`));
	for (const group of summary.groups) {
		lines.push(`  ${paint.accent(group.source)}`);
		const width = Math.max(...group.rules.map((r) => r.name.length));
		for (const rule of [...group.rules].sort((a, b) => a.name.localeCompare(b.name))) {
			const marker = options.activated?.has(rule.path) ? "* " : "  ";
			lines.push(paint.dim(`  ${marker}${rule.name.padEnd(width)}  ${rule.mode.padEnd(8)}  ${rule.scope}`));
			if (options.details) {
				if (rule.description) lines.push(paint.dim(`    ${" ".repeat(width + 2)}${rule.description}`));
				for (const warning of rule.warnings ?? []) lines.push(paint.dim(`    ${" ".repeat(width + 2)}warning: ${warning}`));
			}
		}
	}
	return lines.join("\n");
}
