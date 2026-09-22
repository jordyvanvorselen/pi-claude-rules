import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import ext, { CUSTOM_TYPE } from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface SentMessage {
	customType: string;
	content: string;
	display?: boolean;
	details?: { ruleId: string; path: string };
	options?: { deliverAs?: string } | undefined;
}

interface Entry {
	customType: string;
	data: { kind?: string; ruleId?: string; total?: number; rules?: { name: string }[] };
}

type Renderer = (entry: { customType: string; data: unknown }, options: { expanded: boolean }, theme: unknown) => { render: (width: number) => string[] } | undefined;

const fakeTheme = {
	tag: "",
	fg(this: { tag: string }, color: string, text: string) {
		return `<${this.tag}${color}>${text}</${color}>`;
	},
};

function harness(cwd: string, branch: unknown[] = [], hasUI = true, projection?: () => unknown) {
	const handlers: Record<string, Handler[]> = {};
	const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
	const sent: SentMessage[] = [];
	const entries: Entry[] = [];
	const notices: string[] = [];
	let renderer: Renderer | undefined;
	const pi = {
		on: (e: string, h: Handler) => (handlers[e] ??= []).push(h),
		registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands[name] = opts.handler;
		},
		registerEntryRenderer: (_type: string, r: Renderer) => {
			renderer = r;
		},
		sendMessage: (m: SentMessage, options?: { deliverAs?: string }) => sent.push({ ...m, options }),
		appendEntry: (customType: string, data: Entry["data"]) => {
			entries.push({ customType, data });
			branch.push({ type: "custom", customType, data });
		},
	};
	const ctx = {
		cwd,
		hasUI,
		ui: { notify: (m: string) => notices.push(m) },
		sessionManager: { getBranch: () => branch, ...(projection ? { buildSessionProjection: projection } : {}) },
	};
	ext(pi as never);
	const fire = async (e: string, ev: object) => {
		let result: unknown;
		for (const h of handlers[e] ?? []) result = (await h(ev, ctx)) ?? result;
		return result as Record<string, unknown> | undefined;
	};
	const call = (toolName: string, input: Record<string, unknown>, toolCallId = "t1") =>
		fire("tool_call", { type: "tool_call", toolName, toolCallId, input });
	const command = (name: string, args = "") => commands[name]!(args, ctx);
	const render = (entry: Entry, expanded: boolean) => {
		const component = renderer!(entry, { expanded }, fakeTheme);
		return (component?.render(400) ?? []).map((line) => line.trimEnd()).join("\n");
	};
	const summaries = () => entries.filter((e) => e.data.kind === "summary");
	return { fire, call, command, render, sent, entries, notices, summaries };
}

describe("extension wiring", () => {
	let root: string;
	before(() => {
		root = mkdtempSync(join(tmpdir(), "pi-claude-rules-ext-"));
		mkdirSync(join(root, ".claude", "rules"), { recursive: true });
		mkdirSync(join(root, "backend", "src", "main"), { recursive: true });
		mkdirSync(join(root, ".pi"), { recursive: true });
		// Existing activation-focused cases opt into the efficient compatibility mode.
		writeFileSync(join(root, ".pi", "claude-rules.json"), JSON.stringify({ ruleLoading: "onMatch", bashActivation: true }));
		writeFileSync(join(root, ".claude", "rules", "java.md"), '---\npaths:\n  - "backend/src/main/**/*.java"\n---\n# Java rule\n\nUse records.');
		writeFileSync(join(root, ".claude", "rules", "always.md"), "---\nalwaysApply: true\ndescription: Team basics\n---\nBe kind.");
		writeFileSync(join(root, ".claude", "rules", "free.md"), "# Free rule\n\nUnscoped body.");
		writeFileSync(join(root, "backend", "src", "main", "A.java"), "class A {}");
	});
	after(() => rmSync(root, { recursive: true, force: true }));

	it("lists rules in the system prompt and inlines always-apply rules", async () => {
		const h = harness(root);
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		const result = await h.fire("before_agent_start", { systemPrompt: "BASE", prompt: "hi" });
		const prompt = String(result?.systemPrompt);
		assert.ok(prompt.startsWith("BASE"));
		assert.match(prompt, /## Project rules/);
		assert.match(prompt, /#### Team basics \(\.claude\/rules\/always\.md\)\n\nBe kind\./);
		assert.match(prompt, /- Java rule \(\.claude\/rules\/java\.md\)\. applies to: backend\/src\/main\/\*\*\/\*\.java\./);
		assert.match(prompt, /- Free rule \(\.claude\/rules\/free\.md\)\. applies to any task\./);
		assert.ok(!prompt.includes("Unscoped body."), "unscoped rules are listed, not inlined, by default");
	});

	it("uses hybrid loading by default and makes a read available before the next edit", async () => {
		rmSync(join(root, ".pi", "claude-rules.json"));
		try {
			const h = harness(root);
			await h.fire("session_start", { type: "session_start", reason: "startup" });
			const result = await h.fire("before_agent_start", { systemPrompt: "BASE", prompt: "hi" });
			const prompt = String(result?.systemPrompt);
			assert.ok(!prompt.includes("Use records."), "scoped bodies are not globally eager");
			assert.match(prompt, /Unscoped body\./);
			await h.call("read", { path: "backend/src/main/A.java" }, "read-1");
			const patched = await h.fire("tool_result", { type: "tool_result", toolName: "read", toolCallId: "read-1", content: [{ type: "text", text: "file" }], isError: false });
			assert.match(JSON.stringify(patched?.content), /Use records\./);
			await h.fire("context", { type: "context", messages: [] });
			const edit = await h.call("edit", { path: "backend/src/main/A.java", edits: [] }, "edit-1");
			assert.equal(edit, undefined, "the edit is allowed after the read result crossed context");
		} finally {
			writeFileSync(join(root, ".pi", "claude-rules.json"), JSON.stringify({ ruleLoading: "onMatch", bashActivation: true }));
		}
	});

	it("blocks a direct mutation with the full missing rule", async () => {
		rmSync(join(root, ".pi", "claude-rules.json"));
		try {
			const h = harness(root);
			await h.fire("session_start", { type: "session_start", reason: "startup" });
			const blocked = await h.call("edit", { path: "backend/src/main/A.java", edits: [] });
			assert.equal(blocked?.block, true);
			assert.match(String(blocked?.reason), /Use records\./);
			assert.match(String(blocked?.reason), /retry/i);
			assert.equal(h.sent.length, 0);
		} finally {
			writeFileSync(join(root, ".pi", "claude-rules.json"), JSON.stringify({ ruleLoading: "onMatch", bashActivation: true }));
		}
	});

	it("blocks a same-batch edit even when a read came first", async () => {
		rmSync(join(root, ".pi", "claude-rules.json"));
		try {
			const h = harness(root);
			await h.fire("session_start", { type: "session_start", reason: "startup" });
			await h.call("read", { path: "backend/src/main/A.java" }, "read-batch");
			const blocked = await h.call("edit", { path: "backend/src/main/A.java", edits: [] }, "edit-batch");
			assert.equal(blocked?.block, true);
		} finally {
			writeFileSync(join(root, ".pi", "claude-rules.json"), JSON.stringify({ ruleLoading: "onMatch", bashActivation: true }));
		}
	});

	it("loads rules even when the read itself fails", async () => {
		rmSync(join(root, ".pi", "claude-rules.json"));
		try {
			const h = harness(root);
			await h.fire("session_start", { type: "session_start", reason: "startup" });
			await h.call("read", { path: "backend/src/main/NotYetCreated.java" }, "read-failed");
			const patched = await h.fire("tool_result", { type: "tool_result", toolName: "read", toolCallId: "read-failed", content: [{ type: "text", text: "missing" }], isError: true });
			assert.match(JSON.stringify(patched?.content), /Use records\./);
		} finally {
			writeFileSync(join(root, ".pi", "claude-rules.json"), JSON.stringify({ ruleLoading: "onMatch", bashActivation: true }));
		}
	});

	it("forgets scoped rules after compaction removes their result", async () => {
		rmSync(join(root, ".pi", "claude-rules.json"));
		let visible = true;
		try {
			const h = harness(root, [], true, () => ({
				entries: visible
					? [{ sourceEntry: { type: "custom_message", customType: CUSTOM_TYPE, details: { ruleId: ".claude/rules/java.md" } }, messages: [{ role: "toolResult", content: [{ type: "text", text: "Use records." }] }] }]
					: [],
			}));
			await h.fire("session_start", { type: "session_start", reason: "startup" });
			await h.fire("session_compact", { type: "session_compact" });
			const active = await h.call("edit", { path: "backend/src/main/A.java", edits: [] });
			assert.equal(active, undefined);
			visible = false;
			await h.fire("session_compact", { type: "session_compact" });
			const blocked = await h.call("edit", { path: "backend/src/main/A.java", edits: [] });
			assert.equal(blocked?.block, true);
		} finally {
			writeFileSync(join(root, ".pi", "claude-rules.json"), JSON.stringify({ ruleLoading: "onMatch", bashActivation: true }));
		}
	});

	it("injects a scoped rule once when a matching file is edited", async () => {
		const h = harness(root);
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		await h.call("edit", { path: "backend/src/main/A.java", edits: [] });
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0]!.customType, CUSTOM_TYPE);
		assert.equal(h.sent[0]!.options?.deliverAs, "steer");
		assert.match(h.sent[0]!.content, /Project rule activated: Java rule/);
		assert.match(h.sent[0]!.content, /Use records\./);
		assert.equal(h.sent[0]!.details?.ruleId, ".claude/rules/java.md");
		assert.equal(h.sent[0]!.display, false, "the model-facing message is hidden from the transcript");
		const activation = h.entries.find((e) => e.data.kind === "activation");
		assert.deepEqual(activation?.data.rules?.map((r) => r.name), ["java"], "a TUI-only entry shows the activation");

		await h.call("read", { path: join(root, "backend", "src", "main", "A.java") }, "t2");
		await h.call("bash", { command: "cat backend/src/main/A.java" }, "t3");
		assert.equal(h.sent.length, 1, "the same rule is not injected twice");
		assert.equal(h.entries.filter((e) => e.data.kind === "activation").length, 1);
	});

	it("renders the activation entry compact and expanded", async () => {
		const h = harness(root);
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		await h.call("edit", { path: "backend/src/main/A.java", edits: [] });
		const entry = h.entries.find((e) => e.data.kind === "activation")!;
		assert.equal(h.render(entry, false), "<mdHeading>[Claude rules]</mdHeading> <dim>activated</dim> java");
		assert.equal(h.render(entry, true), ["<mdHeading>[Claude rules]</mdHeading> <dim>activated</dim> java", "<dim>  via backend/src/main/A.java</dim>", "<dim>    java  backend/src/main/**/*.java</dim>"].join("\n"));
	});

	it("does not inject for files outside the rule scope", async () => {
		const h = harness(root);
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		await h.call("write", { path: "backend/src/test/ATest.java", content: "" });
		await h.call("read", { path: "README.md" });
		assert.equal(h.sent.length, 0);
	});

	it("activates through bash commands that mention an existing matching file", async () => {
		const h = harness(root);
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		await h.call("bash", { command: "sed -n 1,5p backend/src/main/A.java" });
		assert.equal(h.sent.length, 1);
	});

	it("remembers injected rules from the resumed session branch", async () => {
		const fromMessage = [{ type: "custom_message", customType: CUSTOM_TYPE, details: { ruleId: ".claude/rules/java.md" } }];
		const h = harness(root, fromMessage);
		await h.fire("session_start", { type: "session_start", reason: "resume" });
		await h.call("edit", { path: "backend/src/main/A.java", edits: [] });
		assert.equal(h.sent.length, 0);

		const fromEntry = [{ type: "custom", customType: CUSTOM_TYPE, data: { kind: "activation", path: "x", rules: [{ ruleId: ".claude/rules/java.md" }] } }];
		const h2 = harness(root, fromEntry);
		await h2.fire("session_start", { type: "session_start", reason: "resume" });
		await h2.call("edit", { path: "backend/src/main/A.java", edits: [] });
		assert.equal(h2.sent.length, 0, "toolResult mode leaves only entries behind and those count too");
	});

	it("appends the rule to the tool result in toolResult mode", async () => {
		writeFileSync(join(root, ".pi", "claude-rules.json"), JSON.stringify({ ruleLoading: "onMatch", activation: "toolResult", notify: false }));
		try {
			const h = harness(root);
			await h.fire("session_start", { type: "session_start", reason: "startup" });
			await h.call("edit", { path: "backend/src/main/A.java", edits: [] }, "call-9");
			assert.equal(h.sent.length, 0);
			assert.equal(h.entries.filter((e) => e.data.kind === "activation").length, 1);
			const patched = await h.fire("tool_result", {
				type: "tool_result",
				toolName: "edit",
				toolCallId: "call-9",
				content: [{ type: "text", text: "ok" }],
			});
			const content = patched?.content as { type: string; text: string }[];
			assert.equal(content.length, 2);
			assert.match(content[1]!.text, /Use records\./);
			assert.equal(h.notices.length, 0);
		} finally {
			writeFileSync(join(root, ".pi", "claude-rules.json"), JSON.stringify({ ruleLoading: "onMatch", bashActivation: true }));
		}
	});

	it("inlines unscoped rules when unscopedRules is inject", async () => {
		writeFileSync(join(root, ".pi", "claude-rules.json"), JSON.stringify({ ruleLoading: "onMatch", unscopedRules: "inject" }));
		try {
			const h = harness(root);
			await h.fire("session_start", { type: "session_start", reason: "startup" });
			const result = await h.fire("before_agent_start", { systemPrompt: "BASE", prompt: "hi" });
			assert.match(String(result?.systemPrompt), /Unscoped body\./);
		} finally {
			writeFileSync(join(root, ".pi", "claude-rules.json"), JSON.stringify({ ruleLoading: "onMatch", bashActivation: true }));
		}
	});

	it("lists rules and reloads through slash commands", async () => {
		const h = harness(root);
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		await h.call("edit", { path: "backend/src/main/A.java", edits: [] });
		await h.command("claude-rules");
		const listing = h.notices.at(-1)!;
		assert.match(listing, /^\[Claude rules\]\n {2}3 rules: 1 always, 1 path-scoped, 1 listed\n {2}\.claude\/rules\n/);
		assert.match(listing, /\* java {4}on match {2}backend\/src\/main\/\*\*\/\*\.java/);
		assert.match(listing, / {2}always {2}always {4}always/);
		assert.match(listing, / {2}free {4}listed {4}any task/);
		assert.match(listing, /Team basics/, "descriptions are shown in the command listing");

		await h.command("claude-rules", "java");
		assert.match(h.notices.at(-1)!, /activated this session[\s\S]*Use records\./);

		assert.equal(h.summaries().length, 1);
		await h.command("claude-rules-reload");
		assert.match(h.notices.at(-1)!, /reloaded: 3 rules/);
		assert.equal(h.summaries().length, 2, "an explicit reload appends a fresh summary block");
		await h.call("edit", { path: "backend/src/main/A.java", edits: [] }, "t5");
		assert.equal(h.sent.length, 2, "reload forgets earlier activations");
	});
});

describe("startup summary entry", () => {
	let root: string;
	before(() => {
		root = mkdtempSync(join(tmpdir(), "pi-claude-rules-summary-"));
		mkdirSync(join(root, ".claude", "rules", "backend"), { recursive: true });
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".claude", "rules", "backend", "java.md"), '---\npaths: "backend/**/*.java"\n---\nJava');
		writeFileSync(join(root, ".claude", "rules", "always.md"), "---\nalwaysApply: true\n---\nAlways");
		writeFileSync(join(root, ".claude", "rules", "free.md"), "Free");
	});
	after(() => rmSync(root, { recursive: true, force: true }));

	const withSettings = async (settings: object, run: () => Promise<void>) => {
		writeFileSync(join(root, ".pi", "claude-rules.json"), JSON.stringify(settings));
		try {
			await run();
		} finally {
			rmSync(join(root, ".pi", "claude-rules.json"));
		}
	};

	it("appends one summary entry on a fresh start and no notification", async () => {
		const h = harness(root);
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		assert.equal(h.summaries().length, 1);
		assert.equal(h.summaries()[0]!.customType, CUSTOM_TYPE);
		assert.equal(h.summaries()[0]!.data.total, 3);
		assert.equal(h.notices.length, 0);
	});

	it("does not append a second summary when the session already has one", async () => {
		const branch: unknown[] = [];
		const first = harness(root, branch);
		await first.fire("session_start", { type: "session_start", reason: "startup" });
		assert.equal(branch.length, 1);

		const resumed = harness(root, branch);
		await resumed.fire("session_start", { type: "session_start", reason: "resume" });
		assert.equal(resumed.summaries().length, 0);
		assert.equal(branch.length, 1);

		const continued = harness(root, branch);
		await continued.fire("session_start", { type: "session_start", reason: "startup" });
		assert.equal(branch.length, 1, "pi -c reports startup with an existing branch");
	});

	it("still appends when the branch only holds activation entries", async () => {
		const branch: unknown[] = [{ type: "custom", customType: CUSTOM_TYPE, data: { kind: "activation", path: "x", rules: [{ ruleId: "x" }] } }];
		const h = harness(root, branch);
		await h.fire("session_start", { type: "session_start", reason: "resume" });
		assert.equal(h.summaries().length, 1);
	});

	it("does nothing without a UI", async () => {
		const h = harness(root, [], false);
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		assert.equal(h.entries.length, 0);
		assert.equal(h.notices.length, 0);
	});

	it("does nothing when no rules are found", async () => {
		const empty = mkdtempSync(join(tmpdir(), "pi-claude-rules-empty-"));
		try {
			const h = harness(empty);
			await h.fire("session_start", { type: "session_start", reason: "startup" });
			assert.equal(h.entries.length, 0);
			assert.equal(h.notices.length, 0);
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("renders compact as a comma joined name list with counts", async () => {
		const h = harness(root);
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		const text = h.render(h.summaries()[0]!, false);
		assert.equal(
			text,
			["<mdHeading>[Claude rules]</mdHeading>", "<dim>  always, free, java</dim>", "<dim>  3 rules: 1 always, 1 path-scoped, 1 listed</dim>"].join("\n"),
		);
	});

	it("renders expanded grouped by source directory with mode and scope", async () => {
		const h = harness(root);
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		const text = h.render(h.summaries()[0]!, true);
		assert.equal(
			text,
			[
				"<mdHeading>[Claude rules]</mdHeading>",
				"<dim>  3 rules: 1 always, 1 path-scoped, 1 listed</dim>",
				"  <accent>.claude/rules</accent>",
				"<dim>    always  always    always</dim>",
				"<dim>    free    listed    any task</dim>",
				"  <accent>.claude/rules/backend</accent>",
				"<dim>    java  on match  backend/**/*.java</dim>",
			].join("\n"),
		);
	});

	it("renders expanded regardless of the toggle when startupSummary is full", async () => {
		await withSettings({ startupSummary: "full" }, async () => {
			const h = harness(root);
			await h.fire("session_start", { type: "session_start", reason: "startup" });
			assert.match(h.render(h.summaries()[0]!, false), /<accent>\.claude\/rules<\/accent>/);
		});
	});

	it("falls back to the notification when startupSummary is off", async () => {
		await withSettings({ startupSummary: "off" }, async () => {
			const h = harness(root);
			await h.fire("session_start", { type: "session_start", reason: "startup" });
			assert.equal(h.summaries().length, 0);
			assert.deepEqual(h.notices, ["claude-rules: 3 rules: 1 always, 1 path-scoped, 1 listed"]);
		});
		await withSettings({ startupSummary: "off", notify: false }, async () => {
			const h = harness(root);
			await h.fire("session_start", { type: "session_start", reason: "startup" });
			assert.equal(h.notices.length, 0);
		});
	});

	it("keeps the summary out of the model context", async () => {
		const h = harness(root);
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		assert.equal(h.sent.length, 0, "no custom messages are sent at startup");
		const result = await h.fire("before_agent_start", { systemPrompt: "BASE", prompt: "hi" });
		assert.ok(!String(result?.systemPrompt).includes("[Claude rules]"));
	});
});
