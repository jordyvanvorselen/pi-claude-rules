import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { activateRules, bashCommandKind, pathsFromCommand, pathsFromToolCall, relativeToRoot, shellTokens } from "../src/activation.ts";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/config.ts";
import { parseRule, type RuleSource } from "../src/rules.ts";

const source: RuleSource = { dir: "/repo/.claude/rules", root: "/repo", label: ".claude/rules", extensions: [".md"] };
const java = parseRule("/repo/.claude/rules/java.md", '---\npaths: "backend/src/main/**/*.java"\n---\nJava', source);
const always = parseRule("/repo/.claude/rules/always.md", "---\nalwaysApply: true\n---\nAlways", source);
const unscoped = parseRule("/repo/.claude/rules/free.md", "Free", source);

describe("shellTokens", () => {
	it("splits on whitespace and honours quotes", () => {
		assert.deepEqual(shellTokens(`cat "a b/c.txt" 'd.txt' e.txt`), ["cat", "a b/c.txt", "d.txt", "e.txt"]);
	});
});

describe("bashCommandKind", () => {
	it("classifies reads and treats redirection as mutation", () => {
		assert.equal(bashCommandKind("cat src/a.ts"), "read");
		assert.equal(bashCommandKind("cat src/a.ts > out.txt"), "mutate");
		assert.equal(bashCommandKind("unknown-command src/a.ts"), "unknown");
	});
});

describe("pathsFromCommand", () => {
	let cwd: string;
	before(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-claude-rules-bash-"));
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "a.ts"), "");
		writeFileSync(join(cwd, "Makefile"), "");
	});
	after(() => rmSync(cwd, { recursive: true, force: true }));

	it("returns existing files mentioned in the command", () => {
		assert.deepEqual(pathsFromCommand("cat src/a.ts | head", cwd), [join(cwd, "src", "a.ts")]);
	});
	it("ignores flags, urls, missing files and directories", () => {
		assert.deepEqual(pathsFromCommand("ls -la src https://x.y/z.ts missing/b.ts", cwd), []);
	});
	it("handles redirects, separators and ./ prefixes", () => {
		assert.deepEqual(pathsFromCommand("echo hi >./src/a.ts; make Makefile", cwd), [join(cwd, "src", "a.ts"), join(cwd, "Makefile")]);
	});
	it("ignores tokens without a slash or extension", () => {
		assert.deepEqual(pathsFromCommand("make Makefile", cwd), [join(cwd, "Makefile")]);
	});
});

describe("pathsFromToolCall", () => {
	let cwd: string;
	before(() => {
		cwd = mkdtempSync(join(tmpdir(), "pi-claude-rules-tools-"));
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "x.ts"), "");
	});
	after(() => rmSync(cwd, { recursive: true, force: true }));

	it("resolves the path field of read and edit against cwd", () => {
		assert.deepEqual(pathsFromToolCall("edit", { path: "src/x.ts" }, cwd, DEFAULT_SETTINGS), [join(cwd, "src", "x.ts")]);
		assert.deepEqual(pathsFromToolCall("read", { path: join(cwd, "src", "x.ts") }, cwd, DEFAULT_SETTINGS), [join(cwd, "src", "x.ts")]);
	});
	it("keeps prospective files but rejects directories for read and edit", () => {
		assert.deepEqual(pathsFromToolCall("read", { path: "src/missing.ts" }, cwd, DEFAULT_SETTINGS), [join(cwd, "src", "missing.ts")]);
		assert.deepEqual(pathsFromToolCall("edit", { path: "src" }, cwd, DEFAULT_SETTINGS), []);
	});
	it("keeps new file paths for write", () => {
		assert.deepEqual(pathsFromToolCall("write", { path: "src/new.ts" }, cwd, DEFAULT_SETTINGS), [join(cwd, "src", "new.ts")]);
	});
	it("ignores tools that are not configured", () => {
		assert.deepEqual(pathsFromToolCall("grep", { path: "src/x.ts" }, cwd, DEFAULT_SETTINGS), []);
		assert.deepEqual(pathsFromToolCall("grep", { path: "src/x.ts" }, cwd, mergeSettings({ tools: ["grep"] })), [join(cwd, "src", "x.ts")]);
	});
	it("skips bash when bashActivation is off", () => {
		assert.deepEqual(pathsFromToolCall("bash", { command: "cat src/x.ts" }, cwd, mergeSettings({ bashActivation: false })), []);
	});
	it("accepts alternative path field names", () => {
		assert.deepEqual(pathsFromToolCall("read", { file_path: "src/x.ts" }, cwd, DEFAULT_SETTINGS), [join(cwd, "src", "x.ts")]);
	});
});

describe("relativeToRoot", () => {
	it("returns a forward slash path inside the root and undefined outside", () => {
		assert.equal(relativeToRoot("/repo/a/b.ts", "/repo"), "a/b.ts");
		assert.equal(relativeToRoot("/other/a.ts", "/repo"), undefined);
		assert.equal(relativeToRoot("/repo", "/repo"), undefined);
	});
});

describe("activateRules", () => {
	it("returns scoped rules whose globs match a touched path", () => {
		const hits = activateRules([java, always, unscoped], ["/repo/backend/src/main/java/A.java"]);
		assert.deepEqual(
			hits.map((h) => [h.rule.name, h.path]),
			[["java", "backend/src/main/java/A.java"]],
		);
	});
	it("returns nothing for non matching or out of root paths", () => {
		assert.deepEqual(activateRules([java], ["/repo/backend/src/test/A.java", "/elsewhere/backend/src/main/A.java"]), []);
	});
	it("reports each rule once even when several paths match", () => {
		const hits = activateRules([java], ["/repo/backend/src/main/A.java", "/repo/backend/src/main/B.java"]);
		assert.equal(hits.length, 1);
	});
});
