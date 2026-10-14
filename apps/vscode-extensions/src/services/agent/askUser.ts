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
  /** Short topic key when the answer is a standing choice (where/which/how this user wants such things), absent for a one-off task decision. */
  remember?: string;
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
    ...(text(q.remember, 40) ? { remember: text(q.remember, 40) } : {}),
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

/**
 * Split the card's answer text back into one answer per question. The card
 * writes `<header or question>: <answer>` per question; an answer may itself
 * span lines, so each answer runs to the next question's label. A question the
 * text does not mention gets ''.
 */
export function answersByQuestion(questions: AskQuestion[], feedback: string): string[] {
  const labels = questions.map((q) => `${q.header || q.question}: `);
  const starts: number[] = [];
  let cursor = 0;
  for (const label of labels) {
    let at = -1;
    for (let i = cursor; i <= feedback.length - label.length; i++) {
      if ((i === 0 || feedback[i - 1] === '\n') && feedback.startsWith(label, i)) {
        at = i;
        break;
      }
    }
    starts.push(at);
    if (at >= 0) cursor = at + label.length;
  }
  return labels.map((label, i) => {
    if (starts[i] < 0) return '';
    const next = starts.slice(i + 1).find((n) => n >= 0);
    return feedback.slice(starts[i] + label.length, next ?? feedback.length).trim();
  });
}
