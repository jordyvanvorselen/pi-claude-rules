export type FrontmatterValue = string | boolean | number | null | FrontmatterValue[];
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedRuleFile {
	frontmatter: Frontmatter;
	body: string;
}

function normalizeNewlines(text: string): string {
	return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function unquote(raw: string): string {
	const value = raw.trim();
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

function stripComment(raw: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(raw[i - 1]!))) {
			return raw.slice(0, i);
		}
	}
	return raw;
}

function splitTopLevel(raw: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	let current = "";
	for (const ch of raw) {
		if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (!inSingle && !inDouble) {
			if (ch === "{" || ch === "[") depth++;
			if (ch === "}" || ch === "]") depth--;
			if (ch === "," && depth === 0) {
				parts.push(current);
				current = "";
				continue;
			}
		}
		current += ch;
	}
	parts.push(current);
	return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

export function parseScalar(raw: string): FrontmatterValue {
	const trimmed = raw.trim();
	if (trimmed === "") return "";
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return splitTopLevel(trimmed.slice(1, -1)).map(parseScalar);
	}
	const isQuoted = /^(["']).*\1$/s.test(trimmed);
	if (isQuoted) return unquote(trimmed);
	const lower = trimmed.toLowerCase();
	if (lower === "true" || lower === "yes" || lower === "on") return true;
	if (lower === "false" || lower === "no" || lower === "off") return false;
	if (lower === "null" || lower === "~") return null;
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
	return trimmed;
}

export function parseFrontmatterBlock(yaml: string): Frontmatter {
	const result: Frontmatter = {};
	const lines = normalizeNewlines(yaml).split("\n");
	let currentKey: string | null = null;
	let listItems: FrontmatterValue[] | null = null;
	let blockScalar: { key: string; lines: string[]; fold: boolean } | null = null;

	const flush = () => {
		if (currentKey && listItems) result[currentKey] = listItems;
		if (blockScalar) {
			const text = blockScalar.fold ? blockScalar.lines.join(" ") : blockScalar.lines.join("\n");
			result[blockScalar.key] = text.trim();
		}
		currentKey = null;
		listItems = null;
		blockScalar = null;
	};

	for (const line of lines) {
		if (blockScalar) {
			if (line.trim() === "" || /^\s+/.test(line)) {
				blockScalar.lines.push(line.trim());
				continue;
			}
			flush();
		}
		const stripped = stripComment(line);
		if (stripped.trim() === "") continue;

		const listMatch = /^\s*-\s*(.*)$/.exec(stripped);
		if (listMatch && currentKey) {
			listItems ??= [];
			listItems.push(parseScalar(listMatch[1] ?? ""));
			continue;
		}

		const keyMatch = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(stripped);
		if (!keyMatch) continue;
		flush();
		const key = keyMatch[1]!;
		const rawValue = (keyMatch[2] ?? "").trim();
		if (rawValue === "") {
			currentKey = key;
			result[key] = null;
			continue;
		}
		if (rawValue === "|" || rawValue === ">" || rawValue === "|-" || rawValue === ">-") {
			blockScalar = { key, lines: [], fold: rawValue.startsWith(">") };
			continue;
		}
		result[key] = parseScalar(rawValue);
	}
	flush();
	return result;
}

export function parseRuleFile(content: string): ParsedRuleFile {
	const text = normalizeNewlines(content);
	if (!text.startsWith("---")) return { frontmatter: {}, body: text.trim() };
	const firstLineEnd = text.indexOf("\n");
	if (firstLineEnd === -1 || text.slice(0, firstLineEnd).trim() !== "---") {
		return { frontmatter: {}, body: text.trim() };
	}
	const closing = /\n---[ \t]*(?:\n|$)/.exec(text.slice(firstLineEnd));
	if (!closing) return { frontmatter: {}, body: text.trim() };
	const yamlStart = firstLineEnd + 1;
	const yamlEnd = firstLineEnd + closing.index;
	const bodyStart = firstLineEnd + closing.index + closing[0].length;
	return {
		frontmatter: parseFrontmatterBlock(text.slice(yamlStart, yamlEnd)),
		body: text.slice(bodyStart).trim(),
	};
}
