import { readFile } from "node:fs/promises";
import type { FileSource, HttpSource, Source } from "./config.ts";
import { expandEnv, getPath, interpolate, renderBody, type Vars } from "./template.ts";

export type SourceResult = { ok: true; text: string; ms: number } | { ok: false; error: string; ms: number };

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_CHARS = 12_000;
const TRUNCATED = "\n[truncated by in-context]";

export interface ResolveOptions {
	vars: Vars;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}

/** Resolve one source to text. Never throws. */
export async function resolveSource(src: Source, opts: ResolveOptions): Promise<SourceResult> {
	const start = Date.now();
	const done = (r: { ok: true; text: string } | { ok: false; error: string }): SourceResult => ({
		...r,
		ms: Date.now() - start,
	});
	try {
		let text: string;
		if ("text" in src) text = interpolate(src.text, opts.vars);
		else if ("file" in src) text = await readSourceFile(src);
		else text = await fetchSource(src, opts);
		return done({ ok: true, text: finish(text, src) });
	} catch (error) {
		return done({ ok: false, error: describe(error) });
	}
}

/** Trim, truncate, wrap. Empty results stay empty (and are dropped by the assembler). */
export function finish(text: string, src: Source): string {
	let t = text.trim();
	if (!t) return "";
	const max = src.maxChars ?? DEFAULT_MAX_CHARS;
	if (t.length > max) t = t.slice(0, max) + TRUNCATED;
	return src.wrap ? `<${src.wrap}>\n${t}\n</${src.wrap}>` : t;
}

async function readSourceFile(src: FileSource): Promise<string> {
	return readFile(src.file, "utf8");
}

async function fetchSource(src: HttpSource, opts: ResolveOptions): Promise<string> {
	const env = opts.env ?? process.env;
	const missing = new Set<string>();
	const url = expandEnv(interpolate(src.url, opts.vars, encodeURIComponent), env, missing);
	const headers: Record<string, string> = { Accept: src.parse === "text" ? "text/plain, */*" : "application/json" };
	for (const [k, v] of Object.entries(src.headers ?? {})) headers[k] = expandEnv(v, env, missing);
	if (missing.size > 0) throw new Error(`missing env: ${[...missing].join(", ")}`);

	const method = src.method ?? "GET";
	let body: string | undefined;
	if (method !== "GET" && src.body !== undefined) {
		body = JSON.stringify(renderBody(src.body, opts.vars));
		headers["Content-Type"] ??= "application/json";
	}

	const timeout = AbortSignal.timeout(src.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
	const res = await (opts.fetchImpl ?? fetch)(url, { method, headers, body, signal });
	if (!res.ok) {
		await res.body?.cancel().catch(() => {});
		throw new Error(`HTTP ${res.status}`);
	}

	// A JSON string can spend up to six bytes per character on escapes.
	const maxChars = src.maxChars ?? DEFAULT_MAX_CHARS;
	const raw = await readCapped(res, maxChars * 6 + 1024);
	if (src.parse === "text") return raw;

	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		throw new Error("response is not valid JSON");
	}
	const field = src.field ?? "content";
	const value = getPath(json, field);
	if (value === undefined || value === null) throw new Error(`field "${field}" missing in response`);
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value, null, 2);
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new Error(`response exceeded ${maxBytes} bytes`);
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

function describe(error: unknown): string {
	if (error instanceof Error) {
		if (error.name === "TimeoutError") return "timed out";
		if (error.name === "AbortError") return "aborted";
		const cause = (error as { cause?: { code?: string } }).cause;
		return cause?.code ? `${error.message} (${cause.code})` : error.message;
	}
	return String(error);
}

/** Resolve many sources concurrently; results keep input order. */
export function resolveAll(sources: Source[], opts: ResolveOptions): Promise<SourceResult[]> {
	return Promise.all(sources.map((s) => resolveSource(s, opts)));
}

export function joinParts(parts: string[]): string {
	return parts.filter((p) => p.length > 0).join("\n\n");
}
