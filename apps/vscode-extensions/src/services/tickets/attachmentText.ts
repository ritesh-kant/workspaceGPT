/**
 * Text attachments on a ticket (logs, stack traces, config) — what a bug's
 * reporter attaches when "it crashes" needs evidence. Provider-neutral and
 * vscode-free so ADO and Jira share it and it is unit-testable.
 */

/** Attachments worth reading as text. Images travel separately; archives, HAR and binaries are skipped. */
const TEXT_ATTACHMENT_RE = /\.(log|txt|out|err|trace|stacktrace|json|ya?ml|xml|csv|md|ini|conf|properties|sql)$/i;

export const MAX_TEXT_ATTACHMENTS = 3;
/** Larger files are not downloaded at all. */
export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
/** What is kept of one: the prompt clips again, but the tail of a log is where the error is. */
const KEEP_HEAD_CHARS = 1_000;
const KEEP_TAIL_CHARS = 1_400;

export function isTextAttachmentName(name: string): boolean {
  return TEXT_ATTACHMENT_RE.test(name);
}

/** The head and tail of a long text: a stack trace is usually at the end of a log. */
export function condenseAttachmentText(text: string): string {
  const t = text.replace(/\r\n/g, '\n').trim();
  if (t.length <= KEEP_HEAD_CHARS + KEEP_TAIL_CHARS) return t;
  return `${t.slice(0, KEEP_HEAD_CHARS)}\n… (${t.length - KEEP_HEAD_CHARS - KEEP_TAIL_CHARS} characters omitted) …\n${t.slice(-KEEP_TAIL_CHARS)}`;
}
