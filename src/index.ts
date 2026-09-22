import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { activateRules, pathsFromToolCall, type Activation } from "./activation.ts";
import { loadSettings, type Settings } from "./config.ts";
import { isInlined, renderActivation, renderSection, scopeLabel } from "./prompt.ts";
import { loadRules, type Rule } from "./rules.ts";
import { buildSources } from "./sources.ts";

export const CUSTOM_TYPE = "claude-rules";

interface ActivationDetails {
	ruleId: string;
	name: string;
	displayPath: string;
	path: string;
	globs: string[];
}

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

function injectedFromSession(ctx: ExtensionContext): Set<string> {
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom_message" && entry.type !== "custom") continue;
		if (entry.customType !== CUSTOM_TYPE) continue;
		const data = (entry.type === "custom_message" ? entry.details : entry.data) as Partial<ActivationDetails> | undefined;
		if (data?.ruleId) ids.add(data.ruleId);
	}
	return ids;
}

function detailsFor(activation: Activation): ActivationDetails {
	return {
		ruleId: activation.rule.id,
		name: activation.rule.name,
		displayPath: activation.rule.displayPath,
		path: activation.path,
		globs: activation.rule.globs,
	};
}

function describeRule(rule: Rule, settings: Settings): string {
	const mode = isInlined(rule, settings) ? "inlined" : rule.mode === "scoped" ? "on match" : "listed";
	const lines = [`${rule.name}  [${mode}]  ${scopeLabel(rule)}`, `    ${rule.displayPath}`];
	if (rule.description) lines.push(`    ${rule.description}`);
	for (const warning of rule.warnings) lines.push(`    warning: ${warning}`);
	return lines.join("\n");
}

export default function claudeRulesExtension(pi: ExtensionAPI) {
	let state: State = { settings: loadSettings(process.cwd()), rules: [], sourceLabels: [], injected: new Set(), pending: new Map() };

	const reload = (ctx: ExtensionContext) => {
		state = freshState(ctx.cwd);
		state.injected = injectedFromSession(ctx);
	};

	const summary = () => {
		const scoped = state.rules.filter((r) => r.mode === "scoped").length;
		const always = state.rules.filter((r) => isInlined(r, state.settings)).length;
		return `${state.rules.length} rule(s): ${always} always, ${scoped} path-scoped, ${state.rules.length - always - scoped} listed`;
	};

	pi.registerMessageRenderer<ActivationDetails>(CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
		const details = message.details;
		const head = theme.fg("accent", "rule ") + theme.fg("dim", "activated: ") + (details?.name ?? "unknown");
		const where = details ? theme.fg("dim", ` (${details.displayPath}, via ${details.path})`) : "";
		let text = head + where;
		if (expanded) {
			const content = typeof message.content === "string" ? message.content : message.content.map((c) => ("text" in c ? c.text : "")).join("\n");
			text += `\n${content}`;
		}
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	pi.on("session_start", async (_event, ctx) => {
		reload(ctx);
		if (state.rules.length > 0 && ctx.hasUI && state.settings.notify) {
			ctx.ui.notify(`claude-rules: ${summary()}`, "info");
		}
	});

	pi.on("before_agent_start", async (event) => {
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

		if (state.settings.activation === "toolResult") {
			state.pending.set(event.toolCallId, fresh);
			for (const activation of fresh) pi.appendEntry(CUSTOM_TYPE, detailsFor(activation));
		} else {
			for (const activation of fresh) {
				pi.sendMessage(
					{ customType: CUSTOM_TYPE, content: renderActivation(activation.rule, activation.path), display: true, details: detailsFor(activation) },
					{ deliverAs: "steer", triggerTurn: false },
				);
			}
		}
		if (ctx.hasUI && state.settings.notify) {
			ctx.ui.notify(`Rule activated: ${fresh.map((a) => a.rule.name).join(", ")}`, "info");
		}
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
				ctx.ui.notify(`${describeRule(rule, state.settings)}\n    status: ${status}\n\n${rule.body}`, "info");
				return;
			}
			if (state.rules.length === 0) {
				ctx.ui.notify(`claude-rules: no rules found. Looked in: ${state.sourceLabels.join(", ") || ".claude/rules, ~/.claude/rules"}`, "info");
				return;
			}
			const lines = [`claude-rules: ${summary()}`, `sources: ${state.sourceLabels.join(", ")}`, ""];
			for (const rule of state.rules) {
				const marker = state.injected.has(rule.id) ? "* " : "  ";
				lines.push(marker + describeRule(rule, state.settings));
			}
			lines.push("", "* = activated this session");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("claude-rules-reload", {
		description: "Rescan rule directories and forget which rules were already activated",
		handler: async (_args, ctx) => {
			reload(ctx);
			state.injected.clear();
			ctx.ui.notify(`claude-rules reloaded: ${summary()}`, "info");
		},
	});
}
