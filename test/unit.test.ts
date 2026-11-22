import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, stripJsonc } from "../src/config.ts";
import { inject, recentMessages } from "../src/tail.ts";
import { expandEnv, getPath, renderBody } from "../src/template.ts";

test("renderBody keeps raw values for whole-string vars", () => {
	const out = renderBody({ q: "{{user_message}}", r: "{{recent}}", s: "id={{session_id}}", n: 1 }, {
		user_message: 'a "quoted" msg', recent: [{ role: "user", text: "x" }], session_id: "abc",
	});
	assert.deepEqual(out, { q: 'a "quoted" msg', r: [{ role: "user", text: "x" }], s: "id=abc", n: 1 });
});

test("expandEnv reports missing variables", () => {
	const missing = new Set<string>();
	assert.equal(expandEnv("Bearer ${env:A}${env:B}", { A: "1" }, missing), "Bearer 1");
	assert.deepEqual([...missing], ["B"]);
});

test("getPath walks objects and arrays", () => {
	assert.equal(getPath({ data: [{ c: "x" }] }, "data.0.c"), "x");
	assert.equal(getPath({ a: 1 }, "a.b"), undefined);
});

test("config lookup order, shadow warning, untrusted project ignored", () => {
	const agent = mkdtempSync(join(tmpdir(), "a-"));
	const cwd = mkdtempSync(join(tmpdir(), "c-"));
	writeFileSync(join(agent, "in-context.json"), JSON.stringify({
		system: { wrap: "persona", sources: [{ text: "x" }, { text: "y", url: "z" }, { file: "p.md" }] },
	}));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "in-context.json"), JSON.stringify({ tail: { sources: [{ text: "t" }] } }));

	const untrusted = loadConfig({ agentDir: agent, cwd, configDirName: ".pi", projectTrusted: false, env: {} });
	assert.equal(untrusted.config.system.wrap, "persona");
	assert.equal(untrusted.config.system.sources.length, 2, "invalid source dropped");
	assert.equal((untrusted.config.system.sources[1] as { file: string }).file, join(agent, "p.md"));
	assert.equal(untrusted.config.tail.sources.length, 0);
	assert.ok(untrusted.warnings.some((w) => w.includes("exactly one of")));
	assert.ok(untrusted.warnings.some((w) => w.includes("not trusted")));

	const trusted = loadConfig({ agentDir: agent, cwd, configDirName: ".pi", projectTrusted: true, env: {} });
	assert.equal(trusted.config.tail.sources.length, 1);

	const viaEnv = loadConfig({ agentDir: agent, cwd, configDirName: ".pi", projectTrusted: false, env: { PI_IN_CONTEXT_CONFIG: "/nope.json" } });
	assert.ok(viaEnv.warnings.some((w) => w.includes("missing file")));
});

test("system mode needs a section-safe wrap; message mode allows null", () => {
	const agent = mkdtempSync(join(tmpdir(), "a-"));
	const cwd = mkdtempSync(join(tmpdir(), "c-"));
	const opts = { agentDir: agent, cwd, configDirName: ".pi", projectTrusted: false, env: {} };
	writeFileSync(join(agent, "in-context.json"), JSON.stringify({ system: { wrap: "Persona" } }));
	const bad = loadConfig(opts);
	assert.equal(bad.config.system.wrap, "in-context");
	assert.ok(bad.warnings.some((w) => w.includes("not a valid section name")));
	writeFileSync(join(agent, "in-context.json"), JSON.stringify({ system: { mode: "message", wrap: null } }));
	const ok = loadConfig(opts);
	assert.equal(ok.config.system.wrap, null);
	assert.equal(ok.warnings.length, 0);
});

test("inject merges into trailing user message, otherwise appends", () => {
	const user = { role: "user" as const, content: "hi", timestamp: 1 };
	const merged = inject([user], "BLOCK", "merge");
	assert.deepEqual(merged[0], { ...user, content: [{ type: "text", text: "hi" }, { type: "text", text: "BLOCK" }] });
	assert.equal(user.content, "hi", "input not mutated");
	const separate = inject([user], "BLOCK", "separate");
	assert.equal(separate.length, 2);
});

test("stripJsonc removes comments and trailing commas but not string content", () => {
	const src = `{
	// line comment
	"a": "keep // this, }", /* block */
	"b": [1, 2, ], "c": "x/*y*/z",
}`;
	assert.deepEqual(JSON.parse(stripJsonc(src)), { a: "keep // this, }", b: [1, 2], c: "x/*y*/z" });
});

test("recentMessages: per-source count, roles and includeCurrent", () => {
	const msgs = [
		{ role: "user", content: "u1", timestamp: 1 },
		{ role: "assistant", content: [{ type: "text", text: "a1" }, { type: "toolCall" }] },
		{ role: "toolResult", content: [{ type: "text", text: "tool out" }] },
		{ role: "custom", content: "recall" },
		{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
		{ role: "user", content: "u2", timestamp: 2 },
	] as never[];
	const current = msgs[5];
	assert.deepEqual(recentMessages(msgs, undefined, current), [
		{ role: "user", text: "u1" }, { role: "assistant", text: "a1" }, { role: "user", text: "u2" },
	]);
	assert.deepEqual(recentMessages(msgs, { count: 2, includeCurrent: false }, current), [
		{ role: "user", text: "u1" }, { role: "assistant", text: "a1" },
	]);
	assert.deepEqual(recentMessages(msgs, { count: 2, roles: ["toolResult", "custom"] }, current), [
		{ role: "toolResult", text: "tool out" }, { role: "custom", text: "recall" },
	]);
	assert.deepEqual(recentMessages(msgs, { count: 0 }, current), []);
});

test("config: per-source recent validated, tail.recentCount warns, JSONC accepted", () => {
	const agent = mkdtempSync(join(tmpdir(), "a-"));
	const cwd = mkdtempSync(join(tmpdir(), "c-"));
	writeFileSync(join(agent, "in-context.json"), `{
		// comment
		"tail": { "recentCount": 3, "sources": [
			{ "text": "ok", "recent": { "count": 2 } },
			{ "text": "bad", "recent": { "roles": "user" } },
		] },
	}`);
	const r = loadConfig({ agentDir: agent, cwd, configDirName: ".pi", projectTrusted: false, env: {} });
	assert.equal(r.config.tail.sources.length, 1);
	assert.ok(r.warnings.some((w) => w.includes("recentCount is no longer used")));
	assert.ok(r.warnings.some((w) => w.includes("recent.roles")));
});
