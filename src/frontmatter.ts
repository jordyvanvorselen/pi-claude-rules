import YAML from "yaml";

export type FrontmatterValue = string | boolean | number | null | FrontmatterValue[];
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedRuleFile {
	frontmatter: Frontmatter;
	body: string;
	warnings: string[];
}

function normalizeNewlines(text: string): string {
	return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function toValue(value: unknown): FrontmatterValue {
	if (typeof value === "string") return value.replace(/\n$/, "");
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (Array.isArray(value)) return value.map(toValue);
	// Rule metadata is scalar/list-shaped. Keep an unsupported YAML mapping
	// harmless and let normalizeFrontmatter report the key if applicable.
	return String(value);
}

function parseBlock(yaml: string): { frontmatter: Frontmatter; warnings: string[] } {
	try {
		const document = YAML.parseDocument(normalizeNewlines(yaml), { strict: true, uniqueKeys: true, version: "1.2" });
		const warnings = document.errors.map((error) => `malformed YAML frontmatter: ${error.message}`);
		if (warnings.length > 0) return { frontmatter: fallbackBlock(yaml), warnings };
		const value = document.toJS({ mapAsMap: false }) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return { frontmatter: {}, warnings: ["malformed YAML frontmatter: expected a mapping"] };
		}
		return {
			frontmatter: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toValue(item)])),
			warnings,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { frontmatter: {}, warnings: [`malformed YAML frontmatter: ${message}`] };
	}
}

// APM has historically emitted unquoted values such as **/*.ts,**/*.tsx,
// which YAML correctly interprets as invalid alias syntax. Keep this narrow
// scalar/list fallback for those deployed files, while retaining YAML errors
// as rule warnings rather than hiding malformed frontmatter.
function fallbackBlock(yaml: string): Frontmatter {
	const result: Frontmatter = {};
	let currentKey: string | undefined;
	for (const line of normalizeNewlines(yaml).split("\n")) {
		const list = /^\s*-\s*(.*)$/.exec(line);
		if (list && currentKey) {
			const previous = result[currentKey];
			const values = Array.isArray(previous) ? previous : [];
			values.push(fallbackScalar(list[1] ?? ""));
			result[currentKey] = values;
			continue;
		}
		const match = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
		if (!match) continue;
		const key = match[1];
		if (!key) continue;
		currentKey = key;
		const value = match[2] ?? "";
		result[key] = value === "" ? null : fallbackScalar(value);
	}
	return result;
}

function fallbackScalar(raw: string): FrontmatterValue {
	const value = raw.trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
	if (value === "true" || value === "yes" || value === "on") return true;
	if (value === "false" || value === "no" || value === "off") return false;
	if (value === "null" || value === "~") return null;
	if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).split(",").map(fallbackScalar);
	return value;
}

export function parseFrontmatterBlock(yaml: string): Frontmatter {
	return parseBlock(yaml).frontmatter;
}

export function parseRuleFile(content: string): ParsedRuleFile {
	const text = normalizeNewlines(content);
	if (!text.startsWith("---")) return { frontmatter: {}, body: text.trim(), warnings: [] };
	const firstLineEnd = text.indexOf("\n");
	if (firstLineEnd === -1 || text.slice(0, firstLineEnd).trim() !== "---") {
		return { frontmatter: {}, body: text.trim(), warnings: [] };
	}
	const closing = /\n---[ \t]*(?:\n|$)/.exec(text.slice(firstLineEnd));
	if (!closing) return { frontmatter: {}, body: text.trim(), warnings: ["unterminated YAML frontmatter"] };
	const yamlStart = firstLineEnd + 1;
	const yamlEnd = firstLineEnd + closing.index;
	const bodyStart = firstLineEnd + closing.index + closing[0].length;
	const parsed = parseBlock(text.slice(yamlStart, yamlEnd));
	return {
		frontmatter: parsed.frontmatter,
		body: text.slice(bodyStart).trim(),
		warnings: parsed.warnings,
	};
}
