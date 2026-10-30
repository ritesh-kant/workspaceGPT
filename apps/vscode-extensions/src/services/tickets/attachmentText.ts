/**
 * Text attachments on a ticket (logs, stack traces, config) — what a bug's
 * reporter attaches when "it crashes" needs evidence. Provider-neutral and
 * vscode-free so ADO and Jira share it and it is unit-testable.
 */
import type { SkippedAttachment, TicketAttachmentContent } from './types';

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

const IMAGE_ATTACHMENT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const HAR_RE = /\.har$/i;

/** The most a person-approved read will download. A HAR of a busy page is tens of MB. */
export const MAX_REQUESTED_ATTACHMENT_BYTES = 50 * 1024 * 1024;
/** What one requested read returns as text. */
const REQUESTED_TEXT_MAX_CHARS = 20_000;

export function isImageAttachmentName(name: string): boolean {
  return IMAGE_ATTACHMENT_RE.test(name);
}

/**
 * Every attached file that was not handed to the model, with the reason.
 * `all` is what the ticket has; `read` the names that were fetched. The reason
 * is derived from the same rules the fetch used, so it is never a guess.
 */
export function skippedAttachmentsOf(all: { name: string; sizeBytes?: number }[], read: string[]): SkippedAttachment[] {
  const done = new Set(read);
  return all
    .filter((a) => a.name && !done.has(a.name))
    .map((a) => {
      let reason = 'not fetched (over the limit of ' + MAX_TEXT_ATTACHMENTS + ' per ticket, or the download failed)';
      if (isImageAttachmentName(a.name)) reason = 'attached image file, not shown automatically';
      else if (!isTextAttachmentName(a.name)) reason = 'file type not read automatically';
      else if (a.sizeBytes && a.sizeBytes > MAX_TEXT_ATTACHMENT_BYTES) reason = 'too large to fetch automatically';
      return { name: a.name, ...(a.sizeBytes ? { sizeBytes: a.sizeBytes } : {}), reason };
    });
}

const MAX_HAR_ROWS = 25;

/**
 * A HAR is mostly bodies and timings; what a bug needs is the requests that
 * failed. Returns the failing/erroring requests (HTTP >= 400, or a GraphQL
 * response carrying `errors`) and a count of the rest.
 */
export function summarizeHar(raw: string): string {
  let entries: any[];
  try {
    entries = JSON.parse(raw)?.log?.entries;
  } catch {
    return '';
  }
  if (!Array.isArray(entries)) return '';
  const rows: string[] = [];
  for (const e of entries) {
    const status = Number(e?.response?.status ?? 0);
    const body = String(e?.response?.content?.text ?? '');
    const gqlErrors = body.includes('"errors"') ? /"errors"\s*:\s*\[[\s\S]{0,400}/.exec(body)?.[0] : undefined;
    if (status < 400 && !gqlErrors) continue;
    const req = e?.request ?? {};
    let op = '';
    try {
      op = JSON.parse(req.postData?.text ?? '')?.operationName ?? '';
    } catch {
      /* not JSON */
    }
    rows.push(
      `- ${status || '?'} ${req.method ?? ''} ${String(req.url ?? '').slice(0, 160)}${op ? ` [${op}]` : ''}${
        gqlErrors ? `\n  ${gqlErrors.replace(/\s+/g, ' ').slice(0, 300)}` : status >= 400 && body ? `\n  ${body.replace(/\s+/g, ' ').slice(0, 200)}` : ''
      }`
    );
  }
  const head = `HAR: ${entries.length} requests, ${rows.length} failing or returning errors.`;
  if (!rows.length) return `${head} None failed — the problem is not a failed request; look at what the page did with a successful one.`;
  const shown = rows.slice(0, MAX_HAR_ROWS);
  return `${head}\n${shown.join('\n')}${rows.length > shown.length ? `\n… ${rows.length - shown.length} more` : ''}`;
}

/** The model-facing content of one attachment the user agreed to read. */
export function requestedAttachmentContent(name: string, buf: ArrayBuffer): TicketAttachmentContent {
  if (HAR_RE.test(name)) {
    const summary = summarizeHar(Buffer.from(buf).toString('utf8'));
    return summary
      ? { name, text: summary, note: 'Summarised: only failing requests and GraphQL errors are shown, not the whole HAR.' }
      : { name, note: 'Could not parse this HAR file.' };
  }
  const bytes = Buffer.from(buf);
  if (bytes.includes(0)) return { name, note: 'Binary file (archive, document or similar) — it cannot be read as text.' };
  const text = bytes.toString('utf8').replace(/\r\n/g, '\n').trim();
  return text.length <= REQUESTED_TEXT_MAX_CHARS
    ? { name, text }
    : { name, text: `${text.slice(0, 6_000)}\n… (${text.length - 6_000 - 14_000} characters omitted) …\n${text.slice(-14_000)}`, note: 'Long file: head and tail shown.' };
}

/** The head and tail of a long text: a stack trace is usually at the end of a log. */
export function condenseAttachmentText(text: string): string {
  const t = text.replace(/\r\n/g, '\n').trim();
  if (t.length <= KEEP_HEAD_CHARS + KEEP_TAIL_CHARS) return t;
  return `${t.slice(0, KEEP_HEAD_CHARS)}\n… (${t.length - KEEP_HEAD_CHARS - KEEP_TAIL_CHARS} characters omitted) …\n${t.slice(-KEEP_TAIL_CHARS)}`;
}
