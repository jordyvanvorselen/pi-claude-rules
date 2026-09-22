import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { activateRules, bashCommandKind, pathsFromToolCall, type Activation } from "./activation.ts";
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
	status?: "loaded" | "blocked";
}

export type EntryData = RuleSummary | ActivationEntry;

interface PendingActivation {
	activations: Activation[];
	deliverInResult: boolean;
}

interface State {
	settings: Settings;
	rules: Rule[];
	sourceLabels: string[];
	/** Rules whose bodies are known to be in the active provider context. */
	injected: Set<string>;
	/** Rules delivered during the current tool batch, awaiting a context boundary. */
	pending: Map<string, PendingActivation>;
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

function activationEntry(activations: Activation[], status?: ActivationEntry["status"]): ActivationEntry {
	const entry: ActivationEntry = { kind: "activation", path: activations[0]?.path ?? "", rules: activations.map(activatedRule) };
	if (status) entry.status = status;
	return entry;
}

function pendingRuleIds(state: State): Set<string> {
	const ids = new Set<string>();
	for (const pending of state.pending.values()) for (const activation of pending.activations) ids.add(activation.rule.id);
	return ids;
}

function promotePending(state: State): void {
	for (const pending of state.pending.values()) for (const activation of pending.activations) state.injected.add(activation.rule.id);
	state.pending.clear();
}

function isReadLike(toolName: string): boolean {
	return toolName === "read" || toolName === "grep" || toolName === "find";
}

function isMutation(toolName: string, input: unknown): boolean {
	if (toolName === "write" || toolName === "edit") return true;
	if (toolName !== "bash" && toolName !== "powershell") return false;
	const value = input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
	const command = typeof value === "string" ? value : "";
	return bashCommandKind(command) !== "read";
}

function blockedReason(activations: readonly Activation[]): string {
	return [
		"Mutation blocked: matching project rules have not reached the model yet.",
		"Apply the rules below, then retry the operation. The first attempt made no filesystem change.",
		...activations.map((activation) => renderActivation(activation.rule, activation.path)),
	].join("\n\n");
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
		const status = act.status === "blocked" ? "blocked before edit" : act.status === "loaded" ? "loaded via read" : "activated";
		const lines = [`${paint.heading("[Claude rules]")} ${paint.dim(status)} ${names}`];
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
		const mode = state.settings.ruleLoading;
		const paths = pathsFromToolCall(event.toolName, event.input, ctx.cwd, state.settings);
		if (paths.length === 0) return;
		const matching = activateRules(state.rules, paths);
		if (matching.length === 0) return;

		if (mode === "eager") {
			const fresh = matching.filter((activation) => !state.injected.has(activation.rule.id));
			if (fresh.length === 0) return;
			for (const activation of fresh) state.injected.add(activation.rule.id);
			// Eager mode already put every body in the system prompt. Keep this
			// optional activation marker TUI-only, never model-facing.
			pi.appendEntry<EntryData>(CUSTOM_TYPE, activationEntry(fresh));
			return;
		}

		const pendingIds = pendingRuleIds(state);
		if (mode === "hybrid" && isMutation(event.toolName, event.input)) {
			const missing = matching.filter((activation) => !state.injected.has(activation.rule.id));
			if (missing.length === 0) return;
			const fresh = missing.filter((activation) => !pendingIds.has(activation.rule.id));
			if (fresh.length > 0) state.pending.set(event.toolCallId, { activations: fresh, deliverInResult: false });
			pi.appendEntry<EntryData>(CUSTOM_TYPE, activationEntry(missing, "blocked"));
			return { block: true, reason: blockedReason(missing), terminate: true };
		}
		if (mode === "hybrid") {
			const bashRead = (event.toolName === "bash" || event.toolName === "powershell") && (() => {
				const command = event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>).command : undefined;
				return typeof command === "string" && bashCommandKind(command) === "read";
			})();
			if (!isReadLike(event.toolName) && !bashRead) return;
		}

		const fresh = matching.filter((activation) => !state.injected.has(activation.rule.id) && !pendingIds.has(activation.rule.id));
		if (fresh.length === 0) return;
		const deliverInResult = mode === "hybrid" || state.settings.activation === "toolResult";
		state.pending.set(event.toolCallId, { activations: fresh, deliverInResult });
		pi.appendEntry<EntryData>(CUSTOM_TYPE, activationEntry(fresh, mode === "hybrid" ? "loaded" : undefined));
		if (mode === "hybrid") return;
		if (state.settings.activation === "toolResult") return;
		for (const activation of fresh) {
			pi.sendMessage(
				{ customType: CUSTOM_TYPE, content: renderActivation(activation.rule, activation.path), display: false, details: activatedRule(activation) },
				{ deliverAs: "steer", triggerTurn: false },
			);
		}
	});

	// Pi emits `context` after all tool results from a response have been
	// persisted and immediately before the next provider request. This is the
	// first boundary at which a read/block result is definitely model-visible.
	pi.on("context", async () => {
		if (state.settings.ruleLoading === "hybrid" || state.settings.ruleLoading === "onMatch") promotePending(state);
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (state.settings.ruleLoading === "hybrid" || state.settings.ruleLoading === "onMatch") {
			state.pending.clear();
			state.injected = injectedFromSession(ctx, state.rules.filter((rule) => rule.mode === "scoped"));
		}
	});

	pi.on("tool_result", async (event) => {
		const pending = state.pending.get(event.toolCallId);
		if (!pending || !pending.deliverInResult) return;
		const extra = pending.activations.map((a) => ({ type: "text" as const, text: `\n\n${renderActivation(a.rule, a.path)}` }));
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
				const status = state.injected.has(rule.id) || pendingRuleIds(state).has(rule.id) ? "activated this session" : isInlined(rule, state.settings) ? "inlined in system prompt" : "not activated yet";
				const one = renderSummary(buildSummary([rule], state.settings), PLAIN, { expanded: true, details: true });
				ctx.ui.notify(`${one}\n    status: ${status}\n\n${rule.body}`, "info");
				return;
			}
			if (state.rules.length === 0) {
				ctx.ui.notify(`claude-rules: no rules found. Looked in: ${state.sourceLabels.join(", ") || ".claude/rules, ~/.claude/rules"}`, "info");
				return;
			}
			const known = new Set([...state.injected, ...pendingRuleIds(state)]);
			const activated = new Set(state.rules.filter((r) => known.has(r.id)).map((r) => r.displayPath));
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
