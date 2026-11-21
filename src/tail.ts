import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Config, sourceKey } from "./config.ts";
import { warn } from "./log.ts";
import { joinParts, resolveAll } from "./source.ts";
import type { Vars } from "./template.ts";

export const TRACE_TYPE = "in-context/tail-trace";

export interface TailStatus {
	enabled: boolean;
	sources: number;
	last?: { at: string; chars: number; ms: number; errors: string[]; cached: boolean };
}

interface RecentItem {
	role: string;
	text: string;
}

/**
 * Per-request injection. Runs in `context_with_system`, which projects the transcript
 * for one provider request and is never persisted, so the block never enters history.
 * `context` is avoided on purpose: a changed `context` list makes pi fold mid-session
 * system patches into the head, which can cost the cached prefix.
 */
export class TailInjector {
	private config?: Config;
	private turnIndex = 0;
	private cacheKey?: string;
	private cacheText = "";
	private last?: TailStatus["last"];

	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	onSessionStart(config: Config): void {
		this.config = config;
		this.cacheKey = undefined;
		this.cacheText = "";
		this.last = undefined;
	}

	onTurnStart(turnIndex: number): void {
		this.turnIndex = turnIndex;
	}

	async onContext(messages: AgentMessage[], ctx: ExtensionContext): Promise<AgentMessage[] | undefined> {
		const config = this.config;
		if (!config?.tail.enabled || config.tail.sources.length === 0) return undefined;

		const user = findLastUser(messages);
		const key = user ? `${user.message.timestamp}:${user.text}` : "";
		let block: string;
		if (config.tail.refresh === "user_message" && key === this.cacheKey) {
			block = this.cacheText;
			if (this.last) this.last = { ...this.last, cached: true };
		} else {
			block = await this.build(user?.text ?? "", messages, ctx, true);
			this.cacheKey = key;
			this.cacheText = block;
		}
		if (!block) return undefined;
		return inject(messages, block, config.tail.placement);
	}

	/** Build the tail block for an arbitrary user message without touching the cache. */
	async preview(userMessage: string, ctx: ExtensionContext): Promise<string> {
		return this.build(userMessage, [], ctx, false);
	}

	status(): TailStatus {
		return { enabled: !!this.config?.tail.enabled, sources: this.config?.tail.sources.length ?? 0, last: this.last };
	}

	private async build(userMessage: string, messages: AgentMessage[], ctx: ExtensionContext, record: boolean): Promise<string> {
		const config = this.config!;
		const vars: Vars = {
			user_message: userMessage,
			recent: recentMessages(messages, config.tail.recentCount),
			session_id: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			model: ctx.model?.id ?? "",
			now: new Date().toISOString(),
			turn_index: this.turnIndex,
		};
		const start = Date.now();
		const results = await resolveAll(config.tail.sources, { vars, signal: ctx.signal });
		const errors = results.flatMap((r, i) => (r.ok ? [] : [`${sourceKey(config.tail.sources[i], i)}: ${r.error}`]));
		if (errors.length > 0) warn(ctx, config.log, `tail source failed: ${errors.join("; ")}`);

		const body = joinParts(results.map((r) => (r.ok ? r.text : "")));
		const wrap = config.tail.wrap;
		const block = body && wrap ? `<${wrap}>\n${body}\n</${wrap}>` : body;

		if (record) {
			this.last = { at: new Date().toISOString(), chars: block.length, ms: Date.now() - start, errors, cached: false };
			if (config.debug) {
				this.pi.appendEntry(TRACE_TYPE, {
					userMessage: userMessage.slice(0, 200),
					chars: block.length,
					results: results.map((r, i) => ({
						source: sourceKey(config.tail.sources[i], i),
						ok: r.ok,
						ms: r.ms,
						...(r.ok ? { chars: r.text.length } : { error: r.error }),
					})),
				});
			}
		}
		return block;
	}
}

// ---------------------------------------------------------------------------

type UserMsg = Extract<AgentMessage, { role: "user" }>;

export function findLastUser(messages: AgentMessage[]): { message: UserMsg; text: string } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "user") return { message: m as UserMsg, text: textOf((m as UserMsg).content) };
	}
	return undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } => !!c && c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

export function recentMessages(messages: AgentMessage[], count: number): RecentItem[] {
	if (count <= 0) return [];
	const out: RecentItem[] = [];
	for (let i = messages.length - 1; i >= 0 && out.length < count; i--) {
		const m = messages[i] as { role: string; content?: unknown };
		if (m.role === "system") continue;
		const text = textOf(m.content).trim();
		if (text) out.push({ role: m.role, text });
	}
	return out.reverse();
}

/**
 * merge: append a text block to the trailing user message (what the Hermes plugin did).
 * Falls back to a separate user message when the transcript ends with something else,
 * e.g. a tool result in the middle of a tool loop.
 */
export function inject(messages: AgentMessage[], block: string, placement: "merge" | "separate"): AgentMessage[] {
	const out = messages.slice();
	const lastIndex = out.length - 1;
	const last = out[lastIndex];
	if (placement === "merge" && last?.role === "user") {
		const u = last as UserMsg;
		const content = typeof u.content === "string" ? [{ type: "text" as const, text: u.content }] : u.content;
		out[lastIndex] = { ...u, content: [...content, { type: "text", text: block }] };
		return out;
	}
	out.push({ role: "user", content: [{ type: "text", text: block }], timestamp: Date.now() });
	return out;
}
