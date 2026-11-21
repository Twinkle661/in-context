import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Config, DEFAULTS, loadConfig, NAME } from "./src/config.ts";
import { warn } from "./src/log.ts";
import { SystemInjector } from "./src/system.ts";
import { TailInjector } from "./src/tail.ts";

export default function inContext(pi: ExtensionAPI) {
	const system = new SystemInjector(pi);
	const tail = new TailInjector(pi);
	let config: Config = DEFAULTS;
	let configPaths: string[] = [];

	const load = (ctx: ExtensionContext) => {
		const loaded = loadConfig({
			agentDir: getAgentDir(),
			cwd: ctx.cwd,
			configDirName: CONFIG_DIR_NAME,
			projectTrusted: ctx.isProjectTrusted(),
		});
		config = loaded.config;
		configPaths = loaded.paths;
		for (const w of loaded.warnings) warn(ctx, config.log, w);
	};

	pi.on("session_start", (_event, ctx) => {
		load(ctx);
		system.onSessionStart(config, ctx);
		tail.onSessionStart(config);
	});

	pi.on("before_agent_start", (event, ctx) => system.onBeforeAgentStart(event, ctx));

	pi.on("turn_start", (event) => tail.onTurnStart(event.turnIndex));

	pi.on("context_with_system", async (event, ctx) => {
		const messages = await tail.onContext(event.messages, ctx);
		return messages ? { messages } : undefined;
	});

	pi.registerCommand(NAME, {
		description: "in-context: status | refresh | preview <message>",
		getArgumentCompletions: (prefix) =>
			["status", "refresh", "preview"]
				.filter((s) => s.startsWith(prefix.trim()))
				.map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/);
			const say = (text: string) => ctx.ui.notify(text, "info");

			if (sub === "status") {
				say(formatStatus(configPaths, system.status(), tail.status()));
			} else if (sub === "refresh") {
				const s = await system.refresh(ctx);
				say(
					s.lastErrors.length > 0
						? `system refreshed with errors (old values kept): ${s.lastErrors.join("; ")}`
						: "system snapshot refreshed; applies from the next message",
				);
			} else if (sub === "preview") {
				const text = rest.join(" ");
				const block = await tail.preview(text, ctx);
				say(block ? block : "(tail would inject nothing)");
			} else {
				ctx.ui.notify(`unknown subcommand "${sub}"; use status | refresh | preview <message>`, "warning");
			}
		},
	});
}

function formatStatus(
	paths: string[],
	s: ReturnType<SystemInjector["status"]>,
	t: ReturnType<TailInjector["status"]>,
): string {
	const lines = [`config: ${paths.length > 0 ? paths.join(" + ") : "(none, defaults)"}`];
	lines.push(
		`system: ${s.enabled ? "on" : "off"} · section <${s.section}> · ${s.lastChars} chars last run` +
			(s.snapshot ? ` · snapshot ${s.snapshot.createdAt} (${Object.keys(s.snapshot.items).length} remote)` : ""),
	);
	if (s.pendingKeys.length > 0) lines.push(`  not fetched yet: ${s.pendingKeys.join(", ")}`);
	if (s.lastErrors.length > 0) lines.push(`  last errors: ${s.lastErrors.join("; ")}`);
	lines.push(`tail: ${t.enabled ? "on" : "off"} · ${t.sources} sources`);
	if (t.last) {
		lines.push(`  last: ${t.last.chars} chars, ${t.last.ms} ms${t.last.cached ? " (cached)" : ""} at ${t.last.at}`);
		if (t.last.errors.length > 0) lines.push(`  last errors: ${t.last.errors.join("; ")}`);
	}
	return lines.join("\n");
}
