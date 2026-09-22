const REGEX_SPECIALS = /[.+^$()|\\]/;

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
	return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

export function normalizeGlob(pattern: string): string {
	let p = pattern.trim().replace(/\\/g, "/");
	while (p.startsWith("./")) p = p.slice(2);
	while (p.startsWith("/")) p = p.slice(1);
	if (p.endsWith("/")) p += "**";
	if (!p.includes("/")) p = `**/${p}`;
	return p;
}

function findClosingBrace(pattern: string, open: number): number {
	let depth = 0;
	for (let i = open; i < pattern.length; i++) {
		if (pattern[i] === "{") depth++;
		else if (pattern[i] === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function findClosingBracket(pattern: string, open: number): number {
	let i = open + 1;
	if (pattern[i] === "!" || pattern[i] === "^") i++;
	if (pattern[i] === "]") i++;
	for (; i < pattern.length; i++) {
		if (pattern[i] === "]") return i;
	}
	return -1;
}

function globToRegexSource(pattern: string): string {
	let out = "";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i]!;
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				const atStart = i === 0 || pattern[i - 1] === "/";
				let j = i + 2;
				while (pattern[j] === "*") j++;
				const followedBySlash = pattern[j] === "/";
				if (atStart && followedBySlash) {
					out += "(?:.*/)?";
					i = j + 1;
					continue;
				}
				if (atStart && j >= pattern.length) {
					out += i === 0 ? ".*" : "(?:.*)?";
					i = j;
					continue;
				}
				out += ".*";
				i = j;
				continue;
			}
			out += "[^/]*";
			i++;
			continue;
		}
		if (ch === "?") {
			out += "[^/]";
			i++;
			continue;
		}
		if (ch === "{") {
			const close = findClosingBrace(pattern, i);
			if (close !== -1) {
				const alternatives = splitGlobList(pattern.slice(i + 1, close)).map(globToRegexSource);
				out += `(?:${alternatives.join("|")})`;
				i = close + 1;
				continue;
			}
		}
		if (ch === "[") {
			const close = findClosingBracket(pattern, i);
			if (close !== -1) {
				let body = pattern.slice(i + 1, close);
				if (body.startsWith("!")) body = `^${body.slice(1)}`;
				out += `[${body.replace(/\\/g, "\\\\")}]`;
				i = close + 1;
				continue;
			}
		}
		out += REGEX_SPECIALS.test(ch) ? `\\${ch}` : ch;
		i++;
	}
	return out;
}

export function globToRegex(pattern: string): RegExp {
	const normalized = normalizeGlob(pattern);
	if (normalized.endsWith("/**")) {
		const prefix = globToRegexSource(normalized.slice(0, -3));
		return new RegExp(`^${prefix}(?:/.*)?$`);
	}
	return new RegExp(`^${globToRegexSource(normalized)}$`);
}

export function matchesGlob(relativePath: string, pattern: string): boolean {
	const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
	return globToRegex(pattern).test(normalizedPath);
}

export function matchesAnyGlob(relativePath: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => matchesGlob(relativePath, pattern));
}
