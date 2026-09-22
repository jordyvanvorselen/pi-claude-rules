import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveDirectory, type Settings } from "./config.ts";
import { isDirectory, type RuleSource } from "./rules.ts";

const MARKDOWN = [".md"];
const CURSOR = [".mdc", ".md"];
const ANY = [".md", ".mdc"];

export function collapseHome(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
	return path;
}

function labelFor(dir: string, cwd: string): string {
	const rel = relative(cwd, dir);
	if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split("\\").join("/");
	return collapseHome(dir);
}

export function ancestorsOf(cwd: string): string[] {
	const dirs: string[] = [];
	let current = resolve(cwd);
	while (true) {
		dirs.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

export function buildSources(cwd: string, settings: Settings): RuleSource[] {
	const sources: RuleSource[] = [];
	const seen = new Set<string>();
	const add = (source: RuleSource) => {
		if (seen.has(source.dir)) return;
		seen.add(source.dir);
		sources.push(source);
	};

	const home = homedir();
	for (const root of ancestorsOf(cwd)) {
		if (root === home) continue;
		add({ dir: join(root, ".claude", "rules"), root, label: labelFor(join(root, ".claude", "rules"), cwd), extensions: MARKDOWN });
		if (settings.cursorRules) {
			add({ dir: join(root, ".cursor", "rules"), root, label: labelFor(join(root, ".cursor", "rules"), cwd), extensions: CURSOR });
		}
	}

	add({ dir: join(home, ".claude", "rules"), root: cwd, label: "~/.claude/rules", extensions: MARKDOWN });

	for (const entry of settings.directories) {
		const dir = resolveDirectory(entry, cwd);
		add({ dir, root: cwd, label: labelFor(dir, cwd), extensions: ANY });
	}

	return sources.filter((source) => isDirectory(source.dir));
}
