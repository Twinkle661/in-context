import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { type Config, sourceKey } from "./config.ts";
import { warn } from "./log.ts";
import { joinParts, resolveSource, type SourceResult } from "./source.ts";
import type { Vars } from "./template.ts";

/** Custom entry holding the snapshot (mode "system"); never sent to the model. */
export const SNAPSHOT_TYPE = "in-context/system";
/** Custom message holding the injected text (mode "message"); sent to the model as user role. */
export const MESSAGE_TYPE = "in-context/system-message";
const RETRY_AFTER_MS = 60_000;

/**
 * `items` holds results of url sources by key; `vars` freezes template variables so the
 * injected text stays byte-identical across runs (stable prompt cache).
 */
export interface Snapshot {
	items: Record<string, string>;
	vars: Vars;
	createdAt: string;
}

export interface SystemStatus {
	enabled: boolean;
	mode: Config["system"]["mode"];
	wrap: string | null;
	snapshot?: Snapshot;
	/** mode "message": whether the message is (already) in this session. */
	injected: boolean;
	lastChars: number;
	pendingKeys: string[];
	lastErrors: string[];
}

/**
 * Session-level injection, two modes.
 *
 * "system": the text is a section of pi's system prompt. pi treats the system prompt as
 * declarative state: it diffs declared sections against the transcript's system message,
 * sends nothing when they match and removes sections that are no longer declared, so the
 * section is declared on every run. Remote content is fetched once per session and kept in
 * a snapshot entry, so resume/fork/reload reuse it.
 *
 * "message": on a new session, before the first user message is stored, the text is
 * stored as a hidden custom message (user role for the model). After that it is ordinary
 * history: nothing re-injects it, and compaction summarises it like anything else.
 */
export class SystemInjector {
	private readonly pi: ExtensionAPI;
	private config?: Config;
	private snapshot?: Snapshot;
	private dirty = false;
	private pending?: Promise<void>;
	private lastFailureAt = 0;
	private lastChars = 0;
	private lastErrors: string[] = [];
	private injected = false;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	onSessionStart(config: Config, ctx: ExtensionContext): void {
		this.config = config;
		this.dirty = false;
		this.pending = undefined;
		this.lastFailureAt = 0;
		this.lastErrors = [];
		this.lastChars = 0;
		this.injected = false;
		if (!config.system.enabled) return;

		if (config.system.mode === "message") {
			this.snapshot = undefined;
			// Only a session with no conversation yet gets the message.
			this.injected = hasConversation(ctx);
			if (this.injected) return;
			this.snapshot = newSnapshot(ctx);
		} else {
			this.snapshot = readSnapshot(ctx);
			if (!this.snapshot) {
				this.snapshot = newSnapshot(ctx);
				this.dirty = true;
			}
		}
		// Prefetch so the first prompt does not wait on the network.
		this.ensureFetched(ctx, false);
	}

	/** mode "message": the session is idle here, so sendMessage stores the entry immediately, ahead of the prompt. */
	async onInput(event: InputEvent, ctx: ExtensionContext): Promise<void> {
		if (event.streamingBehavior !== undefined) return;
		if (!this.wantsMessage(ctx)) return;
		const text = await this.buildMessage(ctx);
		this.injected = true;
		if (text) this.pi.sendMessage({ customType: MESSAGE_TYPE, content: text, display: false });
	}

	async onBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | void> {
		const config = this.config;
		if (!config?.system.enabled) return;

		if (config.system.mode === "message") {
			// Fallback for runs that skip the input hook (e.g. started by a custom message):
			// the message then lands right after the starting message instead of before it.
			if (!this.wantsMessage(ctx)) return;
			const text = await this.buildMessage(ctx);
			this.injected = true;
			return text ? { message: { customType: MESSAGE_TYPE, content: text, display: false } } : undefined;
		}

		if (!this.snapshot) return;
		this.ensureFetched(ctx, false);
		if (this.pending) await this.pending;
		if (this.dirty) {
			this.pi.appendEntry<Snapshot>(SNAPSHOT_TYPE, this.snapshot);
			this.dirty = false;
		}
		const text = await this.assemble(ctx);
		this.lastChars = text.length;
		// pi wraps every custom section in <name>...</name>; mode "system" requires a valid name.
		const name = config.system.wrap!;
		const sections = event.systemPromptOptions.sections;
		if (text) sections[name] = text;
		else delete sections[name];
	}

	/** mode "system": re-fetch every url source and replace the snapshot. Takes effect on the next run. */
	async refresh(ctx: ExtensionContext): Promise<SystemStatus> {
		if (this.config?.system.enabled && this.config.system.mode === "system" && this.snapshot) {
			if (this.pending) await this.pending;
			this.lastFailureAt = 0;
			this.ensureFetched(ctx, true);
			if (this.pending) await this.pending;
			if (this.dirty) {
				this.pi.appendEntry<Snapshot>(SNAPSHOT_TYPE, this.snapshot);
				this.dirty = false;
			}
		}
		return this.status();
	}

	status(): SystemStatus {
		return {
			enabled: !!this.config?.system.enabled,
			mode: this.config?.system.mode ?? "system",
			wrap: this.config?.system.wrap ?? null,
			snapshot: this.snapshot,
			injected: this.injected,
			lastChars: this.lastChars,
			pendingKeys: this.missingKeys(),
			lastErrors: this.lastErrors,
		};
	}

	private wantsMessage(ctx: ExtensionContext): boolean {
		const config = this.config;
		if (!config?.system.enabled || config.system.mode !== "message" || this.injected || !this.snapshot) return false;
		if (hasConversation(ctx)) {
			this.injected = true;
			return false;
		}
		return true;
	}

	/** Failed url sources get one more try here, then are left out: the message is injected only once. */
	private async buildMessage(ctx: ExtensionContext): Promise<string> {
		this.lastFailureAt = 0;
		this.ensureFetched(ctx, false);
		if (this.pending) await this.pending;
		const body = await this.assemble(ctx);
		const wrap = this.config!.system.wrap;
		const text = body && wrap ? `<${wrap}>\n${body}\n</${wrap}>` : body;
		this.lastChars = text.length;
		return text;
	}

	private missingKeys(): string[] {
		if (!this.config || !this.snapshot) return [];
		const items = this.snapshot.items;
		return this.config.system.sources.flatMap((s, i) => {
			const key = sourceKey(s, i);
			return "url" in s && !(key in items) ? [key] : [];
		});
	}

	private ensureFetched(ctx: ExtensionContext, force: boolean): void {
		const config = this.config;
		const snapshot = this.snapshot;
		if (!config || !snapshot || this.pending) return;
		if (!force && Date.now() - this.lastFailureAt < RETRY_AFTER_MS) return;

		const targets = config.system.sources
			.map((src, i) => ({ src, key: sourceKey(src, i) }))
			.filter(({ src, key }) => "url" in src && (force || !(key in snapshot.items)));
		if (targets.length === 0) return;

		this.pending = (async () => {
			const results = await Promise.all(targets.map(({ src }) => resolveSource(src, { vars: snapshot.vars })));
			const items = force ? {} : { ...snapshot.items };
			const errors: string[] = [];
			results.forEach((r: SourceResult, i) => {
				const { key } = targets[i];
				if (r.ok) items[key] = r.text;
				else {
					errors.push(`${key}: ${r.error}`);
					// On a forced refresh keep the previous value rather than dropping it.
					if (force && key in snapshot.items) items[key] = snapshot.items[key];
				}
			});
			this.snapshot = { ...snapshot, items };
			this.dirty = true;
			this.lastErrors = errors;
			if (errors.length > 0) {
				this.lastFailureAt = Date.now();
				const retry = config.system.mode === "system" ? " (will retry)" : "";
				warn(ctx, config.log, `system source failed${retry}: ${errors.join("; ")}`);
			}
		})().finally(() => {
			this.pending = undefined;
		});
	}

	private async assemble(ctx: ExtensionContext): Promise<string> {
		const config = this.config!;
		const snapshot = this.snapshot!;
		const parts = await Promise.all(
			config.system.sources.map(async (src, i) => {
				if ("url" in src) return snapshot.items[sourceKey(src, i)] ?? "";
				// text and file sources are live: edit config + /reload to change them.
				const r = await resolveSource(src, { vars: snapshot.vars });
				if (!r.ok) warn(ctx, config.log, `system source ${sourceKey(src, i)} failed: ${r.error}`);
				return r.ok ? r.text : "";
			}),
		);
		return joinParts(parts);
	}
}

function newSnapshot(ctx: ExtensionContext): Snapshot {
	return { items: {}, vars: baseVars(ctx), createdAt: new Date().toISOString() };
}

function readSnapshot(ctx: ExtensionContext): Snapshot | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type === "custom" && e.customType === SNAPSHOT_TYPE && isSnapshot(e.data)) return e.data;
	}
	return undefined;
}

/** A stored message (or our own injected message) means the conversation has started. */
function hasConversation(ctx: ExtensionContext): boolean {
	return ctx.sessionManager
		.getBranch()
		.some((e) => e.type === "message" || (e.type === "custom_message" && e.customType === MESSAGE_TYPE));
}

function isSnapshot(v: unknown): v is Snapshot {
	return !!v && typeof v === "object" && typeof (v as Snapshot).items === "object" && typeof (v as Snapshot).vars === "object";
}

function baseVars(ctx: ExtensionContext): Vars {
	return {
		session_id: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		model: ctx.model?.id ?? "",
		now: new Date().toISOString(),
	};
}
