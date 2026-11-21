/** Template variables available to sources. Values may be strings, numbers or JSON-able structures. */
export type Vars = Record<string, unknown>;

const WHOLE = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
const INLINE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const ENV = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function stringify(v: unknown): string {
	if (v === undefined || v === null) return "";
	return typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** Inline interpolation of {{var}} inside a string. Unknown variables become "". */
export function interpolate(s: string, vars: Vars, encode?: (s: string) => string): string {
	return s.replace(INLINE, (_m, name: string) => {
		const out = stringify(vars[name]);
		return encode ? encode(out) : out;
	});
}

/**
 * Deep-render a JSON body. A string that is exactly "{{var}}" becomes the raw value
 * (so arrays/objects survive); other strings are interpolated. Object keys are left as-is.
 */
export function renderBody(value: unknown, vars: Vars): unknown {
	if (typeof value === "string") {
		const m = WHOLE.exec(value);
		if (m) return vars[m[1]] ?? null;
		return interpolate(value, vars);
	}
	if (Array.isArray(value)) return value.map((v) => renderBody(v, vars));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = renderBody(v, vars);
		return out;
	}
	return value;
}

/** Expand ${env:NAME}. Missing variables are reported so the caller can skip the source. */
export function expandEnv(s: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
	return s.replace(ENV, (_m, name: string) => {
		const v = env[name];
		if (v === undefined || v === "") {
			missing.add(name);
			return "";
		}
		return v;
	});
}

/** Read a dot path such as "data.items.0.text". */
export function getPath(obj: unknown, path: string): unknown {
	if (path === "" || path === ".") return obj;
	let cur: unknown = obj;
	for (const part of path.split(".")) {
		if (cur === null || cur === undefined) return undefined;
		if (Array.isArray(cur)) {
			const i = Number(part);
			cur = Number.isInteger(i) ? cur[i] : undefined;
		} else if (typeof cur === "object") {
			cur = (cur as Record<string, unknown>)[part];
		} else return undefined;
	}
	return cur;
}
