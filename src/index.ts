import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { activateRules, pathsFromToolCall, type Activation } from "./activation.ts";
import { loadSettings, type Settings } from "./config.ts";
import { isInlined, renderActivation, renderSection } from "./prompt.ts";
import { loadRules, type Rule } from "./rules.ts";
import { buildSources } from "./sources.ts";
import { buildSummary, countsLine, type Paint, PLAIN, renderSummary, type RuleSummary } from "./summary.ts";

export const CUSTOM_TYPE = "claude-rules";

export interface ActivatedRule {
	ruleId: string;
	name: string;
	displayPath: string;
	globs: string[];
}

export interface ActivationEntry {
	kind: "activation";
	path: string;
	rules: ActivatedRule[];
}

export type EntryData = RuleSummary | ActivationEntry;

interface State {
	settings: Settings;
	rules: Rule[];
	sourceLabels: string[];
	injected: Set<string>;
	pending: Map<string, Activation[]>;
}

function freshState(cwd: string): State {
	const settings = loadSettings(cwd);
	const sources = settings.enabled ? buildSources(cwd, settings) : [];
	return {
		settings,
		rules: loadRules(sources),
		sourceLabels: sources.map((s) => s.label),
		injected: new Set(),
		pending: new Map(),
	};
}

type LooseEntry = { kind?: string; ruleId?: string; rules?: { ruleId?: string }[] };

function ownEntries(ctx: ExtensionContext): LooseEntry[] {
	const found: LooseEntry[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom_message" && entry.type !== "custom") continue;
		if (entry.customType !== CUSTOM_TYPE) continue;
		const data = entry.type === "custom_message" ? entry.details : entry.data;
		if (data && typeof data === "object") found.push(data as LooseEntry);
	}
	return found;
}

function injectedFromSession(ctx: ExtensionContext, rules: readonly Rule[] = []): Set<string> {
	const ids = new Set<string>();
	const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
		buildSessionProjection?: () => { entries: { sourceEntry: { type?: string; customType?: string; details?: unknown } }[] };
	};
	// Projection is compaction-aware: custom messages omitted by a compaction
	// are eligible for reinjection. Older Pi versions lack this API, so retain
	// the branch-based fallback for compatibility.
	if (typeof manager.buildSessionProjection === "function") {
		for (const projected of manager.buildSessionProjection().entries) {
			const entry = projected.sourceEntry;
			if (entry.type === "custom_message" && entry.customType === CUSTOM_TYPE) {
				const details = entry.details;
				if (details && typeof details === "object" && "ruleId" in details && typeof details.ruleId === "string") ids.add(details.ruleId);
			}
			// toolResult activation stores the body in a tool-result message.
			const text = JSON.stringify(projected.messages);
			for (const rule of rules) if (text.includes(rule.body)) ids.add(rule.id);
		}
		return ids;
	}
	for (const data of ownEntries(ctx)) {
		if (data.ruleId) ids.add(data.ruleId);
		for (const rule of data.rules ?? []) if (rule.ruleId) ids.add(rule.ruleId);
	}
	return ids;
}

function hasSummaryEntry(ctx: ExtensionContext): boolean {
	return ownEntries(ctx).some((data) => data.kind === "summary");
}

function activationIdsFromEntries(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	for (const data of ownEntries(ctx)) {
		if (data.ruleId) ids.add(data.ruleId);
		for (const rule of data.rules ?? []) if (rule.ruleId) ids.add(rule.ruleId);
	}
	return ids;
}

function activatedRule(activation: Activation): ActivatedRule {
	return { ruleId: activation.rule.id, name: activation.rule.name, displayPath: activation.rule.displayPath, globs: activation.rule.globs };
}

function activationEntry(activations: Activation[]): ActivationEntry {
	return { kind: "activation", path: activations[0]?.path ?? "", rules: activations.map(activatedRule) };
}

function themePaint(theme: { fg: (color: never, text: string) => string }): Paint {
	const fg = (color: string, text: string) => theme.fg(color as never, text);
	return { heading: (t) => fg("mdHeading", t), accent: (t) => fg("accent", t), dim: (t) => fg("dim", t) };
}

export default function claudeRulesExtension(pi: ExtensionAPI) {
	let state: State = { settings: loadSettings(process.cwd()), rules: [], sourceLabels: [], injected: new Set(), pending: new Map() };

	const reload = (ctx: ExtensionContext) => {
		state = freshState(ctx.cwd);
		state.injected = injectedFromSession(ctx, state.rules);
		if (state.settings.ruleLoading === "eager") {
			for (const id of activationIdsFromEntries(ctx)) state.injected.add(id);
		}
	};

	const summary = () => buildSummary(state.rules, state.settings);

	const appendSummary = () => pi.appendEntry<EntryData>(CUSTOM_TYPE, summary());

	pi.registerEntryRenderer<EntryData>(CUSTOM_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const paint = themePaint(theme);
		if (data.kind === "summary") {
			const forceExpanded = state.settings.startupSummary === "full";
			return new Text(renderSummary(data, paint, { expanded: expanded || forceExpanded }), 0, 0);
		}
		const act = data as Partial<ActivationEntry>;
		if (!act.rules?.length) return undefined;
		const names = act.rules.map((r) => r.name).join(", ");
		const lines = [`${paint.heading("[Claude rules]")} ${paint.dim("activated")} ${names}`];
		if (expanded) {
			if (act.path) lines.push(paint.dim(`  via ${act.path}`));
			const width = Math.max(...act.rules.map((r) => r.name.length));
			for (const rule of act.rules) lines.push(paint.dim(`    ${rule.name.padEnd(width)}  ${rule.globs.join(", ")}`));
		}
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		reload(ctx);
		if (state.rules.length === 0 || !ctx.hasUI) return;
		if (state.settings.startupSummary !== "off") {
			if (!hasSummaryEntry(ctx)) appendSummary();
			return;
		}
		if (state.settings.notify) ctx.ui.notify(`claude-rules: ${countsLine(summary())}`, "info");
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!state.settings.enabled || state.rules.length === 0) return;
		const section = renderSection(state.rules, state.settings);
		if (!section) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${section}\n` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state.settings.enabled || state.rules.length === 0) return;
		const paths = pathsFromToolCall(event.toolName, event.input, ctx.cwd, state.settings);
		if (paths.length === 0) return;
		const fresh = activateRules(state.rules, paths).filter((a) => !state.injected.has(a.rule.id));
		if (fresh.length === 0) return;
		for (const activation of fresh) state.injected.add(activation.rule.id);

		// Eager mode already put every body in the system prompt. Keep this
		// optional activation marker TUI-only, but never send a duplicate body.
		pi.appendEntry<EntryData>(CUSTOM_TYPE, activationEntry(fresh));
		if (state.settings.ruleLoading === "eager") return;

		if (state.settings.activation === "toolResult") {
			state.pending.set(event.toolCallId, fresh);
			return;
		}
		for (const activation of fresh) {
			pi.sendMessage(
				{ customType: CUSTOM_TYPE, content: renderActivation(activation.rule, activation.path), display: false, details: activatedRule(activation) },
				{ deliverAs: "steer", triggerTurn: false },
			);
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (state.settings.ruleLoading === "onMatch") state.injected = injectedFromSession(ctx, state.rules);
	});

	pi.on("tool_result", async (event) => {
		const activations = state.pending.get(event.toolCallId);
		if (!activations) return;
		state.pending.delete(event.toolCallId);
		const extra = activations.map((a) => ({ type: "text" as const, text: `\n\n${renderActivation(a.rule, a.path)}` }));
		return { content: [...event.content, ...extra] };
	});

	pi.registerCommand("claude-rules", {
		description: "List discovered Claude Code rules and their scopes (or: /claude-rules <name> to show one)",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (query) {
				const rule = state.rules.find((r) => r.name === query || r.displayPath === query || r.id === query);
				if (!rule) {
					ctx.ui.notify(`No rule named "${query}"`, "warning");
					return;
				}
				const status = state.injected.has(rule.id) ? "activated this session" : isInlined(rule, state.settings) ? "inlined in system prompt" : "not activated yet";
				const one = renderSummary(buildSummary([rule], state.settings), PLAIN, { expanded: true, details: true });
				ctx.ui.notify(`${one}\n    status: ${status}\n\n${rule.body}`, "info");
				return;
			}
			if (state.rules.length === 0) {
				ctx.ui.notify(`claude-rules: no rules found. Looked in: ${state.sourceLabels.join(", ") || ".claude/rules, ~/.claude/rules"}`, "info");
				return;
			}
			const activated = new Set(state.rules.filter((r) => state.injected.has(r.id)).map((r) => r.displayPath));
			const listing = renderSummary(summary(), PLAIN, { expanded: true, details: true, activated });
			ctx.ui.notify(`${listing}\n\n* = activated this session`, "info");
		},
	});

	pi.registerCommand("claude-rules-reload", {
		description: "Rescan rule directories and forget which rules were already activated",
		handler: async (_args, ctx) => {
			reload(ctx);
			state.injected.clear();
			if (ctx.hasUI && state.rules.length > 0 && state.settings.startupSummary !== "off") appendSummary();
			ctx.ui.notify(`claude-rules reloaded: ${countsLine(summary())}`, "info");
		},
	});
}
