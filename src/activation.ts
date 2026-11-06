import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Settings } from "./config.ts";
import { matchesAnyGlob } from "./glob.ts";
import type { Rule } from "./rules.ts";

const PATH_FIELDS = ["path", "file_path", "filePath", "file"] as const;
const BASH_TOOLS = new Set(["bash", "powershell"]);
const READ_ONLY_COMMANDS = new Set([
	"cat",
	"head",
	"tail",
	"sed",
	"awk",
	"grep",
	"rg",
	"find",
	"ls",
	"stat",
	"file",
	"pwd",
	"git",
	"cd",
	"echo",
	"printf",
	"wc",
	"sort",
	"uniq",
	"cut",
	"tr",
	"nl",
	"diff",
	"cmp",
	"basename",
	"dirname",
	"realpath",
	"true",
]);
const MUTATING_COMMANDS = new Set([
	"tee",
	"mv",
	"cp",
	"rm",
	"rmdir",
	"mkdir",
	"touch",
	"chmod",
	"chown",
	"truncate",
	"ln",
	"dd",
	"install",
	"unlink",
	"perl",
	"python",
	"python3",
	"node",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set(["show", "diff", "status", "log", "grep", "ls-files"]);
const FIND_MUTATING_ACTIONS = new Set([
	"-delete",
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-fls",
	"-fprint",
	"-fprint0",
	"-fprintf",
]);
const HARMLESS_REDIRECT_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

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

export type BashCommandKind = "read" | "mutate" | "unknown";

interface CommandSegments {
	segments: string[];
	writesFile: boolean;
	substitutes: boolean;
}

/**
 * Splits a command on unquoted `|`, `;`, `&`, `&&`, `||` and newlines, and
 * strips unquoted output redirections. Redirections to /dev/null or to another
 * file descriptor (`2>&1`) are harmless; any other target counts as a write.
 */
function splitCommand(command: string): CommandSegments {
	const segments: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let writesFile = false;
	let substitutes = false;
	const flush = () => {
		if (current.trim()) segments.push(current.trim());
		current = "";
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i] ?? "";
		if (quote === "'") {
			if (char === "'") quote = undefined;
			current += char;
			continue;
		}
		if (char === "\\") {
			current += char + (command[i + 1] ?? "");
			i++;
			continue;
		}
		if (char === "`" || (char === "$" && command[i + 1] === "(")) substitutes = true;
		if (quote === '"') {
			if (char === '"') quote = undefined;
			current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}
		if (char === ">") {
			let j = i + 1;
			if (command[j] === ">" || command[j] === "|") j++;
			if (command[j] === "&") {
				j++;
				while (/[\d-]/.test(command[j] ?? "")) j++;
			} else {
				while (command[j] === " " || command[j] === "\t") j++;
				const start = j;
				while (j < command.length && !/[\s|;&<>()]/.test(command[j] ?? "")) j++;
				const target = command.slice(start, j).replace(/^["']|["']$/g, "");
				if (!HARMLESS_REDIRECT_TARGETS.has(target)) writesFile = true;
			}
			// Drop the file descriptor number in front of the operator, as in `2>`.
			current = current.replace(/(^|\s)\d+$/, "$1");
			i = j - 1;
			continue;
		}
		if (char === "&" && command[i + 1] === ">") continue;
		if (char === "|" || char === ";" || char === "&" || char === "\n") {
			if ((char === "|" || char === "&") && command[i + 1] === char) i++;
			flush();
			continue;
		}
		current += char;
	}
	flush();
	return { segments, writesFile, substitutes };
}

function segmentKind(segment: string): BashCommandKind {
	const tokens = shellTokens(segment);
	while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
	const first = tokens[0]?.split("/").pop()?.toLowerCase();
	if (!first) return "unknown";
	const args = tokens.slice(1);
	if (MUTATING_COMMANDS.has(first)) return "mutate";
	if (first === "sed" && args.some((arg) => /^-[^-]*i/.test(arg) || arg.startsWith("--in-place"))) {
		return "mutate";
	}
	if (first === "find" && args.some((arg) => FIND_MUTATING_ACTIONS.has(arg))) return "mutate";
	if (first === "awk" && args.some((arg) => /system\s*\(|[>|]/.test(arg))) return "mutate";
	if (first === "sort" && args.some((arg) => /^-[^-]*o|^--output/.test(arg))) return "mutate";
	if (first === "git") {
		const subcommand = args[0]?.toLowerCase();
		return subcommand && READ_ONLY_GIT_SUBCOMMANDS.has(subcommand) ? "read" : "mutate";
	}
	if (READ_ONLY_COMMANDS.has(first)) return "read";
	return "unknown";
}

/**
 * Conservative classification only; this is not a shell parser. Every command
 * word in a pipeline or list must be read-only for the whole command to be a
 * read. Arguments and file names never make a command a mutation by themselves.
 */
export function bashCommandKind(command: string): BashCommandKind {
	const { segments, writesFile, substitutes } = splitCommand(command);
	if (segments.length === 0) return "unknown";
	if (writesFile) return "mutate";
	const kinds = segments.map(segmentKind);
	if (kinds.includes("mutate")) return "mutate";
	if (substitutes || kinds.includes("unknown")) return "unknown";
	return "read";
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
			for (const item of value)
				if (typeof item === "string" && item.trim()) paths.push(resolve(cwd, item.trim().replace(/^@/, "")));
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
