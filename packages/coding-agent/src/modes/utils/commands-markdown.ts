import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "../../slash-commands/builtin-registry";
import { t } from "../i18n";
import { trSlashCommand } from "../i18n/settings";

/**
 * Build the markdown body for the `/help` command output. Lists every
 * registered builtin slash command as `/<name>` plus its one-line
 * description, grouped under a localized header. Aliases are shown in
 * parentheses so users can discover them.
 *
 * The list is regenerated on each call so newly registered commands
 * (e.g. from plugins, loaded after this module is first imported) appear
 * without restarting the session.
 */
export function buildCommandsMarkdown(): string {
	// Hide commands that only make sense in CLI/ACP mode (no `handleTui`) —
	// they would appear in the list but do nothing when invoked from the TUI.
	const visible = BUILTIN_SLASH_COMMANDS_INTERNAL.filter(cmd => cmd.handleTui != null);

	const rows = visible
		.map(cmd => {
			const name = `/${cmd.name}`;
			const aliases = cmd.aliases?.length ? ` (${cmd.aliases.map(a => `/${a}`).join(", ")})` : "";
			const desc = trSlashCommand(cmd.name, cmd.description ?? "");
			return `| \`${name}\`${aliases} | ${desc} |`;
		})
		.join("\n");

	return [
		t("help.intro"),
		"",
		`**${t("help.commands.header")}**`,
		`| ${t("help.table.command")} | ${t("help.table.description")} |`,
		"|---------|-------------|",
		rows,
		"",
		t("help.footer"),
	].join("\n");
}
