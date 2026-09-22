import { minimatch } from "minimatch";

/** Split comma-separated APM/Cursor values without splitting brace alternatives. */
export function splitGlobList(value: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of value) {
		if (ch === "{") depth++;
		if (ch === "}") depth = Math.max(0, depth - 1);
		if (ch === "," && depth === 0) {
			parts.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter(Boolean);
}

export function normalizeGlob(pattern: string): string {
	let normalized = pattern.replace(/\\/g, "/");
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	while (normalized.startsWith("/")) normalized = normalized.slice(1);
	if (normalized.endsWith("/")) normalized += "**";
	if (!normalized.includes("/")) normalized = `**/${normalized}`;
	return normalized;
}

/**
 * Match Claude-style project-relative paths. minimatch supplies the maintained
 * brace/class/** semantics; dot:true keeps .github and other project metadata
 * discoverable just like Claude's project globs.
 */
export function matchesGlob(relativePath: string, pattern: string): boolean {
	const path = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
	try {
		return minimatch(path, normalizeGlob(pattern), { dot: true, nocomment: true, nonegate: true, noext: false });
	} catch {
		// A malformed user glob must not make a tool call or startup fail.
		return false;
	}
}

export function matchesAnyGlob(relativePath: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => matchesGlob(relativePath, pattern));
}
