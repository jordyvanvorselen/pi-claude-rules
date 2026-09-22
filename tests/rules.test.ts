import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/config.ts";
import { dedupeRules, loadRules, normalizeFrontmatter, parseRule, type RuleSource } from "../src/rules.ts";
import { buildSources } from "../src/sources.ts";

const source: RuleSource = { dir: "/repo/.claude/rules", root: "/repo", label: ".claude/rules", extensions: [".md"] };

describe("normalizeFrontmatter", () => {
	it("reads paths as an array", () => {
		const n = normalizeFrontmatter({ paths: ["a/**", "b/**"] }, "", "x");
		assert.deepEqual(n.globs, ["a/**", "b/**"]);
		assert.equal(n.mode, "scoped");
	});
	it("reads paths as a single string", () => {
		assert.deepEqual(normalizeFrontmatter({ paths: "a/**" }, "", "x").globs, ["a/**"]);
	});
	it("reads applyTo as a comma separated string with braces", () => {
		const n = normalizeFrontmatter({ applyTo: "{a,b}/src/**/*.java,c/**/*.java" }, "", "x");
		assert.deepEqual(n.globs, ["{a,b}/src/**/*.java", "c/**/*.java"]);
	});
	it("reads cursor style globs", () => {
		assert.deepEqual(normalizeFrontmatter({ globs: "*.ts,*.tsx" }, "", "x").globs, ["*.ts", "*.tsx"]);
	});
	it("merges paths, applyTo and globs without duplicates", () => {
		const n = normalizeFrontmatter({ paths: "a/**", applyTo: "a/**,b/**", globs: ["c/**"] }, "", "x");
		assert.deepEqual(n.globs, ["a/**", "b/**", "c/**"]);
	});
	it("treats alwaysApply true as always mode even with globs", () => {
		assert.equal(normalizeFrontmatter({ alwaysApply: true, paths: "a/**" }, "", "x").mode, "always");
		assert.equal(normalizeFrontmatter({ always: "yes" }, "", "x").mode, "always");
	});
	it("treats a rule without globs as unscoped", () => {
		assert.equal(normalizeFrontmatter({ description: "d" }, "", "x").mode, "unscoped");
		assert.equal(normalizeFrontmatter({ alwaysApply: false }, "", "x").mode, "unscoped");
	});
	it("uses description, then first heading, then file name as the title", () => {
		assert.equal(normalizeFrontmatter({ description: "Desc" }, "# Heading", "name").title, "Desc");
		assert.equal(normalizeFrontmatter({}, "intro\n\n## Heading two ##\n", "name").title, "Heading two");
		assert.equal(normalizeFrontmatter({}, "no heading", "name").title, "name");
	});
	it("warns about unknown keys and bad alwaysApply values", () => {
		const n = normalizeFrontmatter({ alwaysApply: "maybe", foo: 1 }, "", "x");
		assert.equal(n.mode, "unscoped");
		assert.equal(n.warnings.length, 2);
	});
});

describe("parseRule", () => {
	it("builds ids and display paths relative to the source directory", () => {
		const rule = parseRule("/repo/.claude/rules/backend/api.md", '---\npaths: "b/**"\n---\n# API\nbody', source);
		assert.equal(rule.id, ".claude/rules/backend/api.md");
		assert.equal(rule.displayPath, ".claude/rules/backend/api.md");
		assert.equal(rule.name, "api");
		assert.equal(rule.root, "/repo");
		assert.equal(rule.body, "# API\nbody");
	});
});

describe("dedupeRules", () => {
	it("keeps the first rule for identical bodies and borrows a missing description", () => {
		const a = parseRule("/repo/.claude/rules/x.md", '---\npaths: "a/**"\n---\nSame body', source);
		const b = parseRule("/repo/.cursor/rules/x.mdc", '---\ndescription: "From cursor"\nglobs: "a/**"\n---\nSame body', {
			dir: "/repo/.cursor/rules",
			root: "/repo",
			label: ".cursor/rules",
			extensions: [".mdc"],
		});
		const deduped = dedupeRules([a, b]);
		assert.equal(deduped.length, 1);
		assert.equal(deduped[0]!.displayPath, ".claude/rules/x.md");
		assert.equal(deduped[0]!.description, "From cursor");
		assert.equal(deduped[0]!.title, "From cursor");
	});
});

describe("loadRules and buildSources", () => {
	let root: string;
	before(() => {
		root = mkdtempSync(join(tmpdir(), "pi-claude-rules-"));
		mkdirSync(join(root, ".claude", "rules", "nested"), { recursive: true });
		mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
		mkdirSync(join(root, "extra"), { recursive: true });
		writeFileSync(join(root, ".claude", "rules", "b.md"), '---\npaths:\n  - "src/**/*.ts"\n---\n# B\nb');
		writeFileSync(join(root, ".claude", "rules", "nested", "a.md"), "---\nalwaysApply: true\n---\n# A\na");
		writeFileSync(join(root, ".claude", "rules", "notes.txt"), "ignored");
		writeFileSync(join(root, ".cursor", "rules", "c.mdc"), '---\nglobs: "*.scss"\n---\n# C\nc');
		writeFileSync(join(root, "extra", "d.md"), "# D\nd");
	});
	after(() => rmSync(root, { recursive: true, force: true }));

	it("finds markdown files recursively in .claude/rules only by default", () => {
		const rules = loadRules(buildSources(root, DEFAULT_SETTINGS));
		const names = rules.map((r) => r.name).filter((n) => ["a", "b", "c", "d"].includes(n));
		assert.deepEqual(names, ["b", "a"]);
	});
	it("adds .cursor/rules when cursorRules is on", () => {
		const settings = mergeSettings({ cursorRules: true });
		const rules = loadRules(buildSources(root, settings));
		const c = rules.find((r) => r.name === "c");
		assert.ok(c);
		assert.equal(c.displayPath, ".cursor/rules/c.mdc");
		assert.deepEqual(c.globs, ["*.scss"]);
	});
	it("adds configured extra directories", () => {
		const settings = mergeSettings({ directories: ["extra"] });
		const rules = loadRules(buildSources(root, settings));
		const d = rules.find((r) => r.name === "d");
		assert.ok(d);
		assert.equal(d.mode, "unscoped");
		assert.equal(d.displayPath, "extra/d.md");
	});
	it("picks up rules from an ancestor directory with globs relative to that ancestor", () => {
		const child = join(root, "packages", "app");
		mkdirSync(child, { recursive: true });
		const rules = loadRules(buildSources(child, DEFAULT_SETTINGS));
		const b = rules.find((r) => r.name === "b");
		assert.ok(b);
		assert.equal(b.root, root);
		assert.equal(b.displayPath, join(root, ".claude", "rules", "b.md"));
	});
});
