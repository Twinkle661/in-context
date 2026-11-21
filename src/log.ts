import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";

/**
 * Warnings never go to stdout: in RPC mode stdout is the protocol stream.
 * "auto" shows TUI notifications in tui mode and writes stderr elsewhere, so an
 * RPC client (e.g. a chat bridge) does not receive notification events it might forward.
 */
export function warn(ctx: ExtensionContext | undefined, mode: Config["log"], message: string): void {
	if (mode === "off") return;
	const text = `[in-context] ${message}`;
	const useUi = ctx && ctx.hasUI && (mode === "ui" || (mode === "auto" && ctx.mode === "tui"));
	if (useUi) ctx.ui.notify(text, "warning");
	else console.error(text);
}
