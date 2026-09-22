import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { type Frontmatter, type FrontmatterValue, parseRuleFile } from "./frontmatter.ts";
import { splitGlobList } from "./glob.ts";

export type RuleMode = "always" | "scoped" | "unscoped";

export interface Rule {
	id: string;
	name: string;
	file: string;
	displayPath: string;
	sourceDir: string;
	root: string;
	description: string | undefined;
	title: string;
	globs: string[];
	mode: RuleMode;
	body: string;
	warnings: string[];
}

export interface RuleSource {
	dir: string;
	root: string;
	label: string;
	extensions: string[];
}

const GLOB_KEYS = ["paths", "applyTo", "globs"] as const;
const ALWAYS_KEYS = ["alwaysApply", "always"] as const;

function asStringList(value: FrontmatterValue | undefined): string[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value.flatMap(asStringList);
	if (typeof value === "string") return splitGlobList(value);
	return [String(value)];
}

function asBoolean(value: FrontmatterValue | undefined): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const lower = value.trim().toLowerCase();
		if (lower === "true" || lower === "yes") return true;
		if (lower === "false" || lower === "no" || lower === "") return false;
	}
	return undefined;
}

function firstHeading(body: string): string | undefined {
	const match = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(body);
	return match?.[1]?.trim();
}

export function normalizeFrontmatter(frontmatter: Frontmatter, body: string, name: string) {
	const warnings: string[] = [];
	const globs = GLOB_KEYS.flatMap((key) => asStringList(frontmatter[key]));
	const alwaysValue = ALWAYS_KEYS.map((key) => frontmatter[key]).find((v) => v !== undefined);
	const always = asBoolean(alwaysValue);
	if (alwaysValue !== undefined && always === undefined) {
		warnings.push(`alwaysApply has unrecognised value ${JSON.stringify(alwaysValue)}, treating as false`);
	}
	const descriptionValue = frontmatter.description;
	const description = typeof descriptionValue === "string" && descriptionValue.trim() ? descriptionValue.trim() : undefined;
	const mode: RuleMode = always ? "always" : globs.length > 0 ? "scoped" : "unscoped";
	const knownKeys = new Set<string>([...GLOB_KEYS, ...ALWAYS_KEYS, "description", "name", "title"]);
	for (const key of Object.keys(frontmatter)) {
		if (!knownKeys.has(key)) warnings.push(`unknown frontmatter key "${key}" ignored`);
	}
	const title = description ?? firstHeading(body) ?? name;
	return { globs: [...new Set(globs)], mode, description, title, warnings };
}

export function parseRule(file: string, content: string, source: RuleSource): Rule {
	const { frontmatter, body } = parseRuleFile(content);
	const relPath = relative(source.dir, file).split("\\").join("/");
	const name = basename(file, extname(file));
	const normalized = normalizeFrontmatter(frontmatter, body, name);
	return {
		id: `${source.label}/${relPath}`,
		name,
		file,
		displayPath: `${source.label}/${relPath}`,
		sourceDir: source.dir,
		root: source.root,
		body,
		...normalized,
	};
}

function walk(dir: string, extensions: string[], visited = new Set<string>()): string[] {
	let real: string;
	try {
		real = realpathSync(dir);
	} catch {
		return [];
	}
	if (visited.has(real)) return [];
	visited.add(real);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const name of names.sort((a, b) => a.localeCompare(b))) {
		const full = join(dir, name);
		let stats: import("node:fs").Stats;
		try {
			stats = statSync(full);
		} catch {
			continue;
		}
		if (stats.isDirectory()) {
			files.push(...walk(full, extensions, visited));
			continue;
		}
		if (stats.isFile() && extensions.some((ext) => name.toLowerCase().endsWith(ext))) files.push(full);
	}
	return files;
}

export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function loadRulesFromSource(source: RuleSource): Rule[] {
	if (!isDirectory(source.dir)) return [];
	return walk(source.dir, source.extensions).map((file) => parseRule(file, readFileSync(file, "utf8"), source));
}

export function dedupeRules(rules: Rule[]): Rule[] {
	const seen = new Map<string, Rule>();
	for (const rule of rules) {
		const key = rule.body.trim();
		const existing = seen.get(key);
		if (!existing) {
			seen.set(key, rule);
			continue;
		}
		if (!existing.description && rule.description) {
			existing.description = rule.description;
			existing.title = rule.description;
		}
		if (existing.globs.length === 0 && rule.globs.length > 0 && existing.mode !== "always") {
			existing.globs = rule.globs;
			existing.mode = "scoped";
		}
	}
	return [...seen.values()];
}

export function loadRules(sources: RuleSource[]): Rule[] {
	const all = sources.flatMap((source) => loadRulesFromSource({ ...source, dir: resolve(source.dir), root: resolve(source.root) }));
	return dedupeRules(all);
}
