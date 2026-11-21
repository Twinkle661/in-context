import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Config, sourceKey } from "./config.ts";
import { warn } from "./log.ts";
import { joinParts, resolveSource, type SourceResult } from "./source.ts";
import type { Vars } from "./template.ts";

export const SNAPSHOT_TYPE = "in-context/system";
const RETRY_AFTER_MS = 60_000;

/**
 * Persisted per session (custom entry, never sent to the model).
 * `items` holds results of url sources by key; `vars` freezes template variables so
 * the section text stays byte-identical across runs (stable prompt cache).
 */
export interface Snapshot {
	items: Record<string, string>;
	vars: Vars;
	createdAt: string;
}

export interface SystemStatus {
	enabled: boolean;
	section: string;
	snapshot?: Snapshot;
	lastChars: number;
	pendingKeys: string[];
	lastErrors: string[];
}

/**
 * Session-level injection. The section is declared on every run because pi treats
 * the system prompt as declarative state: it diffs declared sections against the
 * transcript's system message, sends nothing when they match, and removes sections
 * that are no longer declared. Remote content is fetched once per session and kept
 * in the snapshot, so resume/fork/reload reuse it.
 */
export class SystemInjector {
	private config?: Config;
	private snapshot?: Snapshot;
	private dirty = false;
	private pending?: Promise<void>;
	private lastFailureAt = 0;
	private lastChars = 0;
	private lastErrors: string[] = [];

	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	onSessionStart(config: Config, ctx: ExtensionContext): void {
		this.config = config;
		this.snapshot = readSnapshot(ctx);
		this.dirty = false;
		this.pending = undefined;
		this.lastFailureAt = 0;
		this.lastErrors = [];
		if (!config.system.enabled) return;
		if (!this.snapshot) {
			this.snapshot = { items: {}, vars: baseVars(ctx), createdAt: new Date().toISOString() };
			this.dirty = true;
		}
		// Prefetch so the first prompt does not wait on the network.
		this.ensureFetched(ctx, false);
	}

	async onBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<void> {
		const config = this.config;
		if (!config?.system.enabled || !this.snapshot) return;

		this.ensureFetched(ctx, false);
		if (this.pending) await this.pending;

		if (this.dirty) {
			this.pi.appendEntry<Snapshot>(SNAPSHOT_TYPE, this.snapshot);
			this.dirty = false;
		}

		const text = await this.assemble(ctx);
		this.lastChars = text.length;
		const sections = event.systemPromptOptions.sections;
		if (text) sections[config.system.section] = text;
		else delete sections[config.system.section];
	}

	/** Re-fetch every url source and replace the snapshot. Takes effect on the next run. */
	async refresh(ctx: ExtensionContext): Promise<SystemStatus> {
		if (this.config?.system.enabled && this.snapshot) {
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
			section: this.config?.system.section ?? "",
			snapshot: this.snapshot,
			lastChars: this.lastChars,
			pendingKeys: this.missingKeys(),
			lastErrors: this.lastErrors,
		};
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
			const results = await Promise.all(
				targets.map(({ src }) => resolveSource(src, { vars: snapshot.vars })),
			);
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
				warn(ctx, config.log, `system source failed (will retry): ${errors.join("; ")}`);
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

function readSnapshot(ctx: ExtensionContext): Snapshot | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type === "custom" && e.customType === SNAPSHOT_TYPE && isSnapshot(e.data)) return e.data;
	}
	return undefined;
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
