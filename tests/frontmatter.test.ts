import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFrontmatterBlock, parseRuleFile } from "../src/frontmatter.ts";

describe("parseRuleFile", () => {
	it("returns the whole file as body when there is no frontmatter", () => {
		const parsed = parseRuleFile("# Title\n\nBody");
		assert.deepEqual(parsed.frontmatter, {});
		assert.equal(parsed.body, "# Title\n\nBody");
	});
	it("separates frontmatter from body", () => {
		const parsed = parseRuleFile('---\npaths:\n  - "src/**/*.ts"\n---\n\n# Title\n\nBody\n');
		assert.deepEqual(parsed.frontmatter, { paths: ["src/**/*.ts"] });
		assert.equal(parsed.body, "# Title\n\nBody");
	});
	it("handles CRLF line endings and a BOM", () => {
		const parsed = parseRuleFile("\uFEFF---\r\ndescription: hi\r\n---\r\nBody\r\n");
		assert.deepEqual(parsed.frontmatter, { description: "hi" });
		assert.equal(parsed.body, "Body");
	});
	it("treats an unterminated frontmatter block as body", () => {
		const parsed = parseRuleFile("---\npaths: x\nBody");
		assert.deepEqual(parsed.frontmatter, {});
	});
	it("does not confuse a horizontal rule in the body with a closing fence", () => {
		const parsed = parseRuleFile("---\ndescription: a\n---\nIntro\n\n---\n\nMore");
		assert.equal(parsed.frontmatter.description, "a");
		assert.equal(parsed.body, "Intro\n\n---\n\nMore");
	});
});

describe("parseFrontmatterBlock", () => {
	it("parses quoted and unquoted strings", () => {
		const fm = parseFrontmatterBlock('description: "quoted value"\napplyTo: src/**/*.ts');
		assert.equal(fm.description, "quoted value");
		assert.equal(fm.applyTo, "src/**/*.ts");
	});
	it("keeps unquoted glob values that YAML would reject", () => {
		const fm = parseFrontmatterBlock("globs: **/*.ts,**/*.tsx");
		assert.equal(fm.globs, "**/*.ts,**/*.tsx");
	});
	it("parses block lists", () => {
		const fm = parseFrontmatterBlock('paths:\n  - "a/**"\n  - b/**\n');
		assert.deepEqual(fm.paths, ["a/**", "b/**"]);
	});
	it("parses inline lists", () => {
		const fm = parseFrontmatterBlock('paths: ["a/**", "b/{c,d}/**"]');
		assert.deepEqual(fm.paths, ["a/**", "b/{c,d}/**"]);
	});
	it("parses booleans", () => {
		const fm = parseFrontmatterBlock("alwaysApply: true\nalways: false");
		assert.equal(fm.alwaysApply, true);
		assert.equal(fm.always, false);
	});
	it("ignores comments and blank lines", () => {
		const fm = parseFrontmatterBlock("# comment\n\ndescription: value # trailing\n");
		assert.equal(fm.description, "value");
	});
	it("keeps a hash inside a quoted string", () => {
		const fm = parseFrontmatterBlock('description: "issue #12"');
		assert.equal(fm.description, "issue #12");
	});
	it("parses folded and literal block scalars", () => {
		const fm = parseFrontmatterBlock("description: >\n  line one\n  line two\nother: |\n  a\n  b\n");
		assert.equal(fm.description, "line one line two");
		assert.equal(fm.other, "a\nb");
	});
	it("returns null for keys without a value", () => {
		const fm = parseFrontmatterBlock("paths:\ndescription: x");
		assert.equal(fm.paths, null);
		assert.equal(fm.description, "x");
	});
});
