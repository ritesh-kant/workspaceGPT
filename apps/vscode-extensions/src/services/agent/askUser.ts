/**
 * ask_user's arguments, made safe to render. Pure, so the unit tests can pin
 * it without a host.
 *
 * Lenient on shape and strict on size: a model that sends one question at the
 * top level, or its options as bare strings, still gets a card; anything past
 * 4 questions × 4 options is dropped rather than rendered as a wall.
 */

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function normalizeOption(raw: unknown): AskOption | null {
  if (typeof raw === 'string') {
    const label = text(raw, 120);
    return label ? { label } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const label = text(o.label, 120);
  if (!label) return null;
  const description = text(o.description, 300);
  return description ? { label, description } : { label };
}

function normalizeQuestion(raw: unknown): AskQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  const question = text(q.question, 500);
  if (!question) return null;
  const options = (Array.isArray(q.options) ? q.options : [])
    .map(normalizeOption)
    .filter((o): o is AskOption => !!o)
    .slice(0, MAX_OPTIONS);
  const header = text(q.header, 24);
  return {
    question,
    ...(header ? { header } : {}),
    options,
    ...(q.multiSelect === true ? { multiSelect: true } : {}),
  };
}

export function normalizeQuestions(args: unknown): AskQuestion[] {
  if (!args || typeof args !== 'object') return [];
  const a = args as Record<string, unknown>;
  const list = Array.isArray(a.questions) ? a.questions : a.question ? [a] : [];
  return list
    .map(normalizeQuestion)
    .filter((q): q is AskQuestion => !!q)
    .slice(0, MAX_QUESTIONS);
}
