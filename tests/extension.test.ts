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
	details?: { ruleId: string; path: string };
	options?: { deliverAs?: string } | undefined;
}

function harness(cwd: string, branch: unknown[] = []) {
	const handlers: Record<string, Handler[]> = {};
	const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
	const sent: SentMessage[] = [];
	const entries: unknown[] = [];
	const notices: string[] = [];
	const pi = {
		on: (e: string, h: Handler) => (handlers[e] ??= []).push(h),
		registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands[name] = opts.handler;
		},
		registerMessageRenderer: () => {},
		sendMessage: (m: SentMessage, options?: { deliverAs?: string }) => sent.push({ ...m, options }),
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
	};
	const ctx = {
		cwd,
		hasUI: true,
		ui: { notify: (m: string) => notices.push(m) },
		sessionManager: { getBranch: () => branch },
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
	return { fire, call, command, sent, entries, notices };
}

describe("extension wiring", () => {
	let root: string;
	before(() => {
		root = mkdtempSync(join(tmpdir(), "pi-claude-rules-ext-"));
		mkdirSync(join(root, ".claude", "rules"), { recursive: true });
		mkdirSync(join(root, "backend", "src", "main"), { recursive: true });
		mkdirSync(join(root, ".pi"), { recursive: true });
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

	it("injects a scoped rule once when a matching file is edited", async () => {
		const h = harness(root);
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		await h.call("edit", { path: "backend/src/main/A.java", edits: [] });
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0]!.customType, CUSTOM_TYPE);
		assert.equal(h.sent[0]!.options?.deliverAs, "steer");
		assert.match(h.sent[0]!.content, /Project rule activated: Java rule/);
		assert.match(h.sent[0]!.content, /Use records\./);
		assert.equal(h.sent[0]!.details?.path, "backend/src/main/A.java");

		await h.call("read", { path: join(root, "backend", "src", "main", "A.java") }, "t2");
		await h.call("bash", { command: "cat backend/src/main/A.java" }, "t3");
		assert.equal(h.sent.length, 1, "the same rule is not injected twice");
		assert.ok(h.notices.some((n) => /Rule activated: java/.test(n)));
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
		const branch = [{ type: "custom_message", customType: CUSTOM_TYPE, details: { ruleId: ".claude/rules/java.md" } }];
		const h = harness(root, branch);
		await h.fire("session_start", { type: "session_start", reason: "resume" });
		await h.call("edit", { path: "backend/src/main/A.java", edits: [] });
		assert.equal(h.sent.length, 0);
	});

	it("appends the rule to the tool result in toolResult mode", async () => {
		writeFileSync(join(root, ".pi", "claude-rules.json"), JSON.stringify({ activation: "toolResult", notify: false }));
		try {
			const h = harness(root);
			await h.fire("session_start", { type: "session_start", reason: "startup" });
			await h.call("edit", { path: "backend/src/main/A.java", edits: [] }, "call-9");
			assert.equal(h.sent.length, 0);
			assert.equal(h.entries.length, 1);
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
			rmSync(join(root, ".pi", "claude-rules.json"));
		}
	});

	it("inlines unscoped rules when unscopedRules is inject", async () => {
		writeFileSync(join(root, ".pi", "claude-rules.json"), JSON.stringify({ unscopedRules: "inject" }));
		try {
			const h = harness(root);
			await h.fire("session_start", { type: "session_start", reason: "startup" });
			const result = await h.fire("before_agent_start", { systemPrompt: "BASE", prompt: "hi" });
			assert.match(String(result?.systemPrompt), /Unscoped body\./);
		} finally {
			rmSync(join(root, ".pi", "claude-rules.json"));
		}
	});

	it("lists rules and reloads through slash commands", async () => {
		const h = harness(root);
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		await h.call("edit", { path: "backend/src/main/A.java", edits: [] });
		await h.command("claude-rules");
		const listing = h.notices.at(-1)!;
		assert.match(listing, /3 rule\(s\): 1 always, 1 path-scoped, 1 listed/);
		assert.match(listing, /\* java {2}\[on match\] {2}backend\/src\/main\/\*\*\/\*\.java/);
		assert.match(listing, /always {2}\[inlined\]/);

		await h.command("claude-rules", "java");
		assert.match(h.notices.at(-1)!, /activated this session[\s\S]*Use records\./);

		await h.command("claude-rules-reload");
		assert.match(h.notices.at(-1)!, /reloaded: 3 rule\(s\)/);
		await h.call("edit", { path: "backend/src/main/A.java", edits: [] }, "t5");
		assert.equal(h.sent.length, 2, "reload forgets earlier activations");
	});
});
