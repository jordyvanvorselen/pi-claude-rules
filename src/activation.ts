import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Settings } from "./config.ts";
import { matchesAnyGlob } from "./glob.ts";
import type { Rule } from "./rules.ts";

const PATH_FIELDS = ["path", "file_path", "filePath", "file"] as const;
const BASH_TOOLS = new Set(["bash", "powershell"]);

export function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Compatibility helper; activation intentionally does not require a file to exist. */
export function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

export function shellTokens(command: string): string[] {
	const tokens: string[] = [];
	const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(command)) !== null) {
		const token = match[1] ?? match[2] ?? match[3] ?? "";
		tokens.push(token.replace(/\\(.)/g, "$1"));
	}
	return tokens;
}

export function pathsFromCommand(command: string, cwd: string): string[] {
	const found: string[] = [];
	for (const raw of shellTokens(command)) {
		const token = raw.replace(/^[<>|&;(]+/, "").replace(/[<>|&;),:]+$/, "");
		if (!token || token.startsWith("-") || token.startsWith("$")) continue;
		if (/^[a-z]+:\/\//i.test(token)) continue;
		const absolute = resolve(cwd, token.startsWith("~/") ? token.replace(/^~/, process.env.HOME ?? "") : token);
		// Do not claim to parse shell syntax. We conservatively inspect existing
		// files, including extensionless Dockerfile/Makefile-style paths.
		if (existsSync(absolute) && !isDirectory(absolute)) found.push(absolute);
	}
	return [...new Set(found)];
}

export function pathsFromToolCall(toolName: string, input: unknown, cwd: string, settings: Settings): string[] {
	if (!input || typeof input !== "object") return [];
	const record = input as Record<string, unknown>;
	if (BASH_TOOLS.has(toolName)) {
		if (!settings.bashActivation) return [];
		const command = record.command;
		return typeof command === "string" ? pathsFromCommand(command, cwd) : [];
	}
	if (!settings.tools.includes(toolName)) return [];
	const paths: string[] = [];
	for (const field of PATH_FIELDS) {
		const value = record[field];
		if (typeof value === "string" && value.trim()) paths.push(resolve(cwd, value.trim().replace(/^@/, "")));
		if (Array.isArray(value)) {
			for (const item of value) if (typeof item === "string" && item.trim()) paths.push(resolve(cwd, item.trim().replace(/^@/, "")));
		}
	}
	// read/edit may be aimed at a file that the model is about to create. Keep
	// prospective paths, but never activate a directory when it is knowable.
	return [...new Set(paths.filter((path) => !isDirectory(path)))];
}

export function relativeToRoot(absolutePath: string, root: string): string | undefined {
	const rel = relative(root, absolutePath);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return rel.split("\\").join("/");
}

export interface Activation {
	rule: Rule;
	path: string;
}

export function activateRules(rules: readonly Rule[], absolutePaths: readonly string[]): Activation[] {
	const activations: Activation[] = [];
	for (const rule of rules) {
		if (rule.mode !== "scoped") continue;
		for (const absolutePath of absolutePaths) {
			const rel = relativeToRoot(absolutePath, rule.root);
			if (rel && matchesAnyGlob(rel, rule.globs)) {
				activations.push({ rule, path: rel });
				break;
			}
		}
	}
	return activations;
}
