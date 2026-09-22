import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type UnscopedMode = "list" | "inject";
export type ActivationMode = "message" | "toolResult";

export interface Settings {
	directories: string[];
	cursorRules: boolean;
	unscopedRules: UnscopedMode;
	tools: string[];
	bashActivation: boolean;
	activation: ActivationMode;
	notify: boolean;
	enabled: boolean;
}

export const SETTINGS_FILE = "claude-rules.json";

export const DEFAULT_SETTINGS: Settings = {
	directories: [],
	cursorRules: false,
	unscopedRules: "list",
	tools: ["read", "write", "edit"],
	bashActivation: true,
	activation: "message",
	notify: true,
	enabled: true,
};

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export function resolveDirectory(path: string, cwd: string): string {
	const expanded = expandHome(path);
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function readJson(file: string): Partial<Settings> {
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Partial<Settings>) : {};
	} catch {
		return {};
	}
}

export function mergeSettings(...layers: Partial<Settings>[]): Settings {
	const merged: Settings = { ...DEFAULT_SETTINGS, directories: [...DEFAULT_SETTINGS.directories], tools: [...DEFAULT_SETTINGS.tools] };
	for (const layer of layers) {
		if (Array.isArray(layer.directories)) merged.directories = [...merged.directories, ...layer.directories.filter((d) => typeof d === "string")];
		if (typeof layer.cursorRules === "boolean") merged.cursorRules = layer.cursorRules;
		if (layer.unscopedRules === "list" || layer.unscopedRules === "inject") merged.unscopedRules = layer.unscopedRules;
		if (Array.isArray(layer.tools)) merged.tools = layer.tools.filter((t) => typeof t === "string");
		if (typeof layer.bashActivation === "boolean") merged.bashActivation = layer.bashActivation;
		if (layer.activation === "message" || layer.activation === "toolResult") merged.activation = layer.activation;
		if (typeof layer.notify === "boolean") merged.notify = layer.notify;
		if (typeof layer.enabled === "boolean") merged.enabled = layer.enabled;
	}
	merged.directories = [...new Set(merged.directories)];
	return merged;
}

export function loadSettings(cwd: string): Settings {
	const userFile = join(agentDir(), SETTINGS_FILE);
	const projectFile = join(cwd, ".pi", SETTINGS_FILE);
	return mergeSettings(readJson(userFile), readJson(projectFile));
}
