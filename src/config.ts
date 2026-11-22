import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What {{recent}} exposes for this source (tail only). */
export interface RecentOptions {
	/** How many messages, newest last. Default 6. */
	count?: number;
	/** pi message roles to keep. Default ["user", "assistant"]. */
	roles?: string[];
	/** Include the current user message (also available as {{user_message}}). Default true. */
	includeCurrent?: boolean;
}

export const RECENT_DEFAULTS: Required<RecentOptions> = { count: 6, roles: ["user", "assistant"], includeCurrent: true };

interface SourceBase {
	/** Stable key for the system snapshot. Defaults to the source's position + url. */
	id?: string;
	enabled?: boolean;
	/** Wrap this item in <wrap>...</wrap>. */
	wrap?: string;
	/** Truncate this item to maxChars. */
	maxChars?: number;
	/** Shape of {{recent}} for this source (tail only). */
	recent?: RecentOptions;
}

export interface TextSource extends SourceBase {
	text: string;
}

export interface FileSource extends SourceBase {
	/** Absolute, ~/-prefixed, or relative to the config file's directory (resolved at load). */
	file: string;
}

export interface HttpSource extends SourceBase {
	url: string;
	method?: "GET" | "POST" | "PUT";
	headers?: Record<string, string>;
	/**
	 * JSON value; "{{var}}" strings are replaced with the variable's raw value.
	 * POST/PUT without a body send DEFAULT_BODY.
	 */
	body?: unknown;
	/** "json" (default) reads `field`; "text" uses the whole body. */
	parse?: "json" | "text";
	/** Dot path into the JSON response, e.g. "data.0.content". Default "content". */
	field?: string;
	timeoutMs?: number;
}

export type Source = TextSource | FileSource | HttpSource;

export interface SystemConfig {
	enabled: boolean;
	/**
	 * "system": a section of pi's system prompt, re-declared every run (pi keeps it in the
	 * transcript's system message; compaction never touches it).
	 * "message": one hidden user-role message stored before the first user message of a
	 * new session, then left alone (compaction summarises it like any other message).
	 */
	mode: "system" | "message";
	/**
	 * Wrapper tag. In "system" mode it is also the section name pi wraps the text in, so it
	 * must match /^[a-z][a-z0-9_-]*$/ and cannot be null. In "message" mode null means no wrapper.
	 */
	wrap: string | null;
	sources: Source[];
}

export interface TailConfig {
	enabled: boolean;
	refresh: "user_message" | "request";
	placement: "merge" | "separate";
	/** Outer wrapper tag for the whole tail block; null disables it. */
	wrap: string | null;
	sources: Source[];
}

export interface Config {
	system: SystemConfig;
	tail: TailConfig;
	/** Where warnings go. "auto": TUI notifications in tui mode, stderr otherwise. */
	log: "auto" | "ui" | "stderr" | "off";
	/** Record each tail injection as a custom session entry (never sent to the model). */
	debug: boolean;
}

export interface LoadedConfig {
	config: Config;
	/** Files actually read, in merge order. */
	paths: string[];
	warnings: string[];
}

export const NAME = "in-context";
export const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
const TAG_NAME = /^[A-Za-z][A-Za-z0-9_.:-]*$/;

export const DEFAULTS: Config = {
	system: { enabled: true, mode: "system", wrap: "in-context", sources: [] },
	tail: {
		enabled: true,
		refresh: "user_message",
		placement: "merge",
		wrap: "in-context",
		sources: [],
	},
	log: "auto",
	debug: false,
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadOptions {
	agentDir: string;
	cwd: string;
	configDirName: string;
	projectTrusted: boolean;
	env?: NodeJS.ProcessEnv;
}

/**
 * Lookup order for the base config (first hit wins):
 *   1. $PI_IN_CONTEXT_CONFIG
 *   2. <agentDir>/in-context.json(c)
 *   3. <extension dir>/config.json(c)
 * Then <cwd>/.pi/in-context.json(c) is merged on top when the project is trusted.
 * Every file is parsed as JSONC (comments and trailing commas allowed); .json wins over .jsonc.
 */
export function loadConfig(opts: LoadOptions): LoadedConfig {
	const env = opts.env ?? process.env;
	const warnings: string[] = [];
	const paths: string[] = [];

	const candidates: string[] = [];
	if (env.PI_IN_CONTEXT_CONFIG) candidates.push(expandHome(env.PI_IN_CONTEXT_CONFIG));
	const agentPath = firstExisting(join(opts.agentDir, NAME));
	const extPath = firstExisting(join(EXTENSION_DIR, "config"));
	candidates.push(agentPath, extPath);

	const basePath = candidates.find((p) => existsSync(p));
	if (env.PI_IN_CONTEXT_CONFIG && basePath !== candidates[0]) {
		warnings.push(`PI_IN_CONTEXT_CONFIG points to a missing file: ${candidates[0]}`);
	}
	if (basePath === agentPath && existsSync(extPath)) {
		warnings.push(`${extPath} is shadowed by ${agentPath}`);
	}

	let config = structuredClone(DEFAULTS);
	if (basePath) {
		const raw = readJson(basePath, warnings);
		if (raw) {
			config = mergeConfig(config, raw, basePath, warnings);
			paths.push(basePath);
		}
	}

	const projectPath = firstExisting(join(opts.cwd, opts.configDirName, NAME));
	if (existsSync(projectPath)) {
		if (opts.projectTrusted) {
			const raw = readJson(projectPath, warnings);
			if (raw) {
				config = mergeConfig(config, raw, projectPath, warnings);
				paths.push(projectPath);
			}
		} else {
			warnings.push(`Ignoring ${projectPath}: project is not trusted`);
		}
	}

	if (config.system.mode === "system") {
		const w = config.system.wrap;
		if (w === null || !SECTION_NAME.test(w) || w === "preamble") {
			warnings.push(
				`system.wrap ${JSON.stringify(w)} is not a valid section name for mode "system" ` +
					`(must match ${SECTION_NAME}, not "preamble"); using "${DEFAULTS.system.wrap}"`,
			);
			config.system.wrap = DEFAULTS.system.wrap;
		}
	}

	return { config, paths, warnings };
}

/** `<stem>.json` if it exists, else `<stem>.jsonc` if it exists, else `<stem>.json`. */
function firstExisting(stem: string): string {
	if (existsSync(`${stem}.json`)) return `${stem}.json`;
	if (existsSync(`${stem}.jsonc`)) return `${stem}.jsonc`;
	return `${stem}.json`;
}

function readJson(path: string, warnings: string[]): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
		if (!isObject(value)) {
			warnings.push(`${path}: top level must be an object`);
			return undefined;
		}
		return value;
	} catch (error) {
		warnings.push(`${path}: ${(error as Error).message}`);
		return undefined;
	}
}

/** Scalars override; `sources` lists from later files are appended. */
function mergeConfig(
	base: Config,
	raw: Record<string, unknown>,
	path: string,
	warnings: string[],
): Config {
	const out = structuredClone(base);
	const where = (k: string) => `${path}: ${k}`;
	const dir = dirname(path);

	if (raw.log !== undefined) {
		if (["auto", "ui", "stderr", "off"].includes(raw.log as string)) out.log = raw.log as Config["log"];
		else warnings.push(`${where("log")} must be auto|ui|stderr|off`);
	}
	if (raw.debug !== undefined) {
		if (typeof raw.debug === "boolean") out.debug = raw.debug;
		else warnings.push(`${where("debug")} must be a boolean`);
	}

	if (raw.system !== undefined) {
		if (!isObject(raw.system)) warnings.push(`${where("system")} must be an object`);
		else {
			const s = raw.system;
			if (s.enabled !== undefined) setBool(s.enabled, (v) => (out.system.enabled = v), where("system.enabled"), warnings);
			if (s.mode !== undefined) {
				if (s.mode === "system" || s.mode === "message") out.system.mode = s.mode;
				else warnings.push(`${where("system.mode")} must be system|message`);
			}
			if (s.wrap !== undefined) {
				if (s.wrap === null || (typeof s.wrap === "string" && TAG_NAME.test(s.wrap))) out.system.wrap = s.wrap;
				else warnings.push(`${where("system.wrap")} must be a tag name or null`);
			}
			out.system.sources.push(...parseSources(s.sources, where("system.sources"), dir, warnings));
		}
	}

	if (raw.tail !== undefined) {
		if (!isObject(raw.tail)) warnings.push(`${where("tail")} must be an object`);
		else {
			const t = raw.tail;
			if (t.enabled !== undefined) setBool(t.enabled, (v) => (out.tail.enabled = v), where("tail.enabled"), warnings);
			if (t.refresh !== undefined) {
				if (t.refresh === "user_message" || t.refresh === "request") out.tail.refresh = t.refresh;
				else warnings.push(`${where("tail.refresh")} must be user_message|request`);
			}
			if (t.placement !== undefined) {
				if (t.placement === "merge" || t.placement === "separate") out.tail.placement = t.placement;
				else warnings.push(`${where("tail.placement")} must be merge|separate`);
			}
			if (t.wrap !== undefined) {
				if (t.wrap === null || (typeof t.wrap === "string" && TAG_NAME.test(t.wrap))) out.tail.wrap = t.wrap;
				else warnings.push(`${where("tail.wrap")} must be a tag name or null`);
			}
			if (t.recentCount !== undefined) {
				warnings.push(`${where("tail.recentCount")} is no longer used; set "recent": { "count": n } on each source`);
			}
			out.tail.sources.push(...parseSources(t.sources, where("tail.sources"), dir, warnings));
		}
	}
	return out;
}

function parseSources(
	value: unknown,
	where: string,
	dir: string,
	warnings: string[],
): Source[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		warnings.push(`${where} must be an array`);
		return [];
	}
	const out: Source[] = [];
	value.forEach((item, i) => {
		const err = validateSource(item);
		if (err) {
			warnings.push(`${where}[${i}] disabled: ${err}`);
			return;
		}
		const src = structuredClone(item) as Source;
		if (src.enabled === false) return;
		if ("file" in src) src.file = resolveFile(src.file, dir);
		out.push(src);
	});
	return out;
}

function validateSource(item: unknown): string | undefined {
	if (!isObject(item)) return "must be an object";
	const kinds = ["text", "file", "url"].filter((k) => item[k] !== undefined);
	if (kinds.length !== 1) return "needs exactly one of text, file, url";
	const kind = kinds[0];
	if (typeof item[kind] !== "string") return `${kind} must be a string`;
	if (item.id !== undefined && typeof item.id !== "string") return "id must be a string";
	if (item.enabled !== undefined && typeof item.enabled !== "boolean") return "enabled must be a boolean";
	if (item.wrap !== undefined && !(typeof item.wrap === "string" && TAG_NAME.test(item.wrap))) return "wrap must be a tag name";
	if (item.maxChars !== undefined && !(Number.isInteger(item.maxChars) && (item.maxChars as number) > 0)) {
		return "maxChars must be a positive integer";
	}
	if (item.recent !== undefined) {
		const r = item.recent;
		if (!isObject(r)) return "recent must be an object";
		if (r.count !== undefined && !(Number.isInteger(r.count) && (r.count as number) >= 0)) {
			return "recent.count must be a non-negative integer";
		}
		if (r.roles !== undefined && !(Array.isArray(r.roles) && r.roles.every((x) => typeof x === "string"))) {
			return "recent.roles must be an array of strings";
		}
		if (r.includeCurrent !== undefined && typeof r.includeCurrent !== "boolean") return "recent.includeCurrent must be a boolean";
	}
	if (kind === "url") {
		if (item.method !== undefined && !["GET", "POST", "PUT"].includes(item.method as string)) return "method must be GET|POST|PUT";
		if (item.headers !== undefined) {
			if (!isObject(item.headers) || Object.values(item.headers).some((v) => typeof v !== "string")) {
				return "headers must be an object of strings";
			}
		}
		if (item.parse !== undefined && item.parse !== "json" && item.parse !== "text") return "parse must be json|text";
		if (item.field !== undefined && typeof item.field !== "string") return "field must be a string";
		if (item.timeoutMs !== undefined && !(typeof item.timeoutMs === "number" && item.timeoutMs > 0)) {
			return "timeoutMs must be a positive number";
		}
		if (item.body !== undefined && (item.method ?? "GET") === "GET") return "body is not allowed with GET";
	}
	return undefined;
}

function setBool(v: unknown, set: (v: boolean) => void, where: string, warnings: string[]) {
	if (typeof v === "boolean") set(v);
	else warnings.push(`${where} must be a boolean`);
}

/** Accept JSONC: drop line and block comments and trailing commas, leaving strings intact. */
export function stripJsonc(src: string): string {
	// Index just past whitespace and comments starting at i.
	const skip = (i: number): number => {
		for (;;) {
			if (/\s/.test(src[i] ?? "")) i++;
			else if (src[i] === "/" && src[i + 1] === "/") {
				while (i < src.length && src[i] !== "\n") i++;
			} else if (src[i] === "/" && src[i + 1] === "*") {
				const end = src.indexOf("*/", i + 2);
				i = end < 0 ? src.length : end + 2;
			} else return i;
		}
	};
	let out = "";
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (c === '"') {
			let j = i + 1;
			while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
			out += src.slice(i, j + 1);
			i = j + 1;
		} else if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) {
			const next = skip(i);
			out += " ";
			i = next;
		} else if (c === ",") {
			const next = skip(i + 1);
			if (src[next] !== "}" && src[next] !== "]") out += c;
			i++;
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

export function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

export function resolveFile(p: string, baseDir: string): string {
	const e = expandHome(p);
	return isAbsolute(e) ? e : resolve(baseDir, e);
}

export function sourceKind(src: Source): "text" | "file" | "url" {
	return "text" in src ? "text" : "file" in src ? "file" : "url";
}

export function sourceKey(src: Source, index: number): string {
	if (src.id) return src.id;
	return "url" in src ? `#${index}:${src.url}` : `#${index}`;
}
