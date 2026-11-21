// End-to-end: real pi process, mock OpenAI-compatible LLM + mock context endpoints.
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const ROOT = resolve(import.meta.dirname, "..");
const llmRequests = [];
const hits = { persona: 0, prompt: [] };

const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (req.url === "/persona") {
    hits.persona++;
    assert.equal(req.headers.authorization, "Bearer test-key");
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ data: { content: `PERSONA#${hits.persona}` } }));
  }
  if (req.url === "/prompt") {
    const j = JSON.parse(body);
    hits.prompt.push(j);
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ content: `RAG for: ${j.user_message}` }));
  }
  if (req.url === "/down") { res.statusCode = 503; return res.end(); }
  if (req.url.endsWith("/chat/completions")) {
    const reqBody = JSON.parse(body);
    llmRequests.push(reqBody);
    res.setHeader("content-type", "text/event-stream");
    const chunk = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
    const wantsTool = JSON.stringify(reqBody.messages).includes("TOOLTEST") && reqBody.messages.at(-2)?.role !== "tool" && reqBody.messages.at(-1)?.role !== "tool";
    if (wantsTool) {
      chunk({ id: "t", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "note.txt" }) } }] }, finish_reason: null }] });
      chunk({ id: "t", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    chunk({ id: "x", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] });
    chunk({ id: "x", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const makeAgentDir = () => {
const agentDir = mkdtempSync(join(tmpdir(), "inctx-agent-"));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({
  providers: { mock: { baseUrl: `${base}/v1`, apiKey: "x", api: "openai-completions",
    models: [{ id: "mock", name: "mock", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } },
}));
mkdirSync(join(agentDir, "persona"));
writeFileSync(join(agentDir, "persona", "a.md"), "FILE-PERSONA");
return agentDir;
};
let agentDir = makeAgentDir();
let cwd = mkdtempSync(join(tmpdir(), "inctx-cwd-"));
writeFileSync(join(agentDir, "in-context.json"), JSON.stringify({
  log: "stderr",
  system: { sources: [
    { text: "STATIC-SYSTEM" },
    { file: "./persona/a.md" },
    { url: `${base}/persona`, headers: { Authorization: "Bearer ${env:INCTX_KEY}" }, field: "data.content" },
  ] },
  tail: { sources: [
    { text: "STATIC-TAIL" },
    { url: `${base}/prompt`, method: "POST", body: { user_message: "{{user_message}}", recent: "{{recent}}" } },
    { url: `${base}/down` },
  ] },
}));

const pi = join(ROOT, "node_modules/.bin/pi");
// Async spawn: the mock server lives in this process, so the event loop must keep running.
const run = (...args) => new Promise((ok, fail) => {
  const p = spawn(pi, ["-p", "--provider", "mock", "--model", "mock", "-e", join(ROOT, "index.ts"), ...args], {
    cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", INCTX_KEY: "test-key" },
  });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => (stdout += d));
  p.stderr.on("data", (d) => (stderr += d));
  p.on("close", (code) => code === 0 ? ok({ stdout, stderr }) : fail(new Error(`pi exited ${code}\n${stdout}\n${stderr}`)));
});
const sysText = (req) => req.messages.filter((m) => m.role === "system" || m.role === "developer")
  .map((m) => typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("")).join("\n");
const userTexts = (req) => req.messages.filter((m) => m.role === "user")
  .map((m) => typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join("\n"));

// Run 1: new session
const r1 = await run("first message");
assert.match(r1.stderr, /tail source failed: .*HTTP 503/, "failing source warns on stderr, not stdout");
assert.doesNotMatch(r1.stdout, /in-context/, "nothing on stdout");
const q1 = llmRequests.at(-1);
const s1 = sysText(q1);
assert.match(s1, /<in-context>\nSTATIC-SYSTEM\n\nFILE-PERSONA\n\nPERSONA#1\n<\/in-context>/);
const u1 = userTexts(q1);
assert.equal(u1.length, 1);
assert.match(u1[0], /^first message/);
assert.match(u1[0], /<in-context>\nSTATIC-TAIL\n\nRAG for: first message\n<\/in-context>$/);
assert.equal(hits.prompt[0].user_message, "first message");
assert.deepEqual(hits.prompt[0].recent, [{ role: "user", text: "first message" }]);

// Run 2: continue the same session
await run("--continue", "second message");
const q2 = llmRequests.at(-1);
assert.equal(hits.persona, 1, "system remote source fetched once per session");
assert.match(sysText(q2), /PERSONA#1/);
const u2 = userTexts(q2);
assert.equal(u2.length, 2);
assert.equal(u2[0], "first message", "old tail block is not in history");
assert.match(u2[1], /RAG for: second message/);

// Run 3: fresh session refetches
await run("third");
assert.equal(hits.persona, 2);
assert.match(sysText(llmRequests.at(-1)), /PERSONA#2/);

// Run 4: tool loop — one fetch per user message, block placed after the tool result
writeFileSync(join(cwd, "note.txt"), "hello from file");
const before = { llm: llmRequests.length, fetch: hits.prompt.length };
await run("TOOLTEST please read");
assert.equal(llmRequests.length - before.llm, 2, "two model requests in the tool loop");
assert.equal(hits.prompt.length - before.fetch, 1, "tail fetched once per user message");
const q4 = llmRequests.at(-1);
const tailMsg = q4.messages.at(-1);
assert.equal(tailMsg.role, "user");
assert.match(JSON.stringify(tailMsg.content), /RAG for: TOOLTEST please read/);
const toolIdx = q4.messages.findIndex((m) => m.role === "tool");
assert.ok(toolIdx > 0 && toolIdx < q4.messages.length - 1, "tail sits after the tool result");

// Mode "message": stored once before the first user message, then plain history
agentDir = makeAgentDir();
cwd = mkdtempSync(join(tmpdir(), "inctx-cwd-"));
writeFileSync(join(agentDir, "in-context.json"), JSON.stringify({
  log: "stderr",
  system: { mode: "message", wrap: "persona", sources: [
    { text: "STATIC-SYSTEM" },
    { url: `${base}/persona`, headers: { Authorization: "Bearer ${env:INCTX_KEY}" }, field: "data.content" },
  ] },
}));
const personaBefore = hits.persona;
await run("hello there");
const m1 = llmRequests.at(-1);
assert.doesNotMatch(sysText(m1), /STATIC-SYSTEM/, "not in the system prompt");
const mu1 = userTexts(m1);
assert.equal(mu1.length, 2);
assert.equal(mu1[0], `<persona>\nSTATIC-SYSTEM\n\nPERSONA#${personaBefore + 1}\n</persona>`, "injected before the first user message");
assert.equal(mu1[1], "hello there");
await run("--continue", "again");
const mu2 = userTexts(llmRequests.at(-1));
assert.equal(hits.persona, personaBefore + 1, "fetched once");
assert.equal(mu2.length, 3, "not injected a second time");
assert.match(mu2[0], /^<persona>/);
assert.deepEqual(mu2.slice(1), ["hello there", "again"]);

console.log(`e2e ok (${llmRequests.length} LLM requests, ${hits.prompt.length} tail fetches)`);
server.close();
