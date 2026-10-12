/**
 * The composer's "/" commands. A command is something the USER typed, so unlike
 * a pattern over prose it may act directly: `/debug` arms Debug mode for the
 * next message, exactly as "+ → Debug a bug" does.
 */
export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'debug', description: 'Work the next message as a bug: reproduce, observe, prove the root cause' },
];

/** What follows a leading "/" while it is still one word, or null when the draft is not a command being typed. */
export function slashQuery(text: string): string | null {
  const m = /^\/([A-Za-z-]*)$/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

export function matchSlashCommands(query: string): SlashCommand[] {
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(query));
}

/**
 * A draft that STARTS with a complete command followed by whitespace ("/debug the
 * login crash"): the command and the rest of the message. Anything else — an
 * unknown "/word", a "/" mid-sentence, a path — is just text.
 */
export function parseSlashCommand(text: string): { command: string; rest: string } | null {
  const m = /^\/([A-Za-z-]+)\s+([\s\S]*)$/.exec(text);
  if (!m) return null;
  const command = m[1].toLowerCase();
  return SLASH_COMMANDS.some((c) => c.name === command) ? { command, rest: m[2] } : null;
}
