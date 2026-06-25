/**
 * Tiny, dependency-free Markdown renderer for assistant messages.
 *
 * The model is instructed to always reply in Markdown and to end with a
 * **Sources** section of `[label](url)` links. Rendering that as raw text left
 * links unclickable and headings/lists looking like literal markup. This covers
 * the subset LLMs actually emit: headings, bold/italic, inline + fenced code,
 * bullet/numbered lists, blockquotes and links — links open in a new tab.
 *
 * It is deliberately not a spec-complete parser; unknown syntax falls through as
 * plain text, which is the safe default for streamed, partially-formed output.
 */
import React from 'react';

let keySeq = 0;
const nextKey = () => `md-${keySeq++}`;

const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Parse inline spans: links, bold, italic, inline code. */
function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Tokenize on the highest-priority markers first; recurse for nesting.
  const pattern =
    /(\[[^\]]+\]\((?:https?:\/\/)[^\s)]+\))|(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)/;

  let rest = text;
  while (rest.length) {
    const m = rest.match(pattern);
    if (!m || m.index === undefined) {
      nodes.push(rest);
      break;
    }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    const token = m[0];

    if (token.startsWith('[')) {
      LINK_RE.lastIndex = 0;
      const lm = LINK_RE.exec(token);
      if (lm) {
        nodes.push(
          <a key={nextKey()} href={lm[2]} target='_blank' rel='noopener noreferrer'>
            {lm[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith('`')) {
      nodes.push(<code key={nextKey()}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={nextKey()}>{renderInline(token.slice(2, -2))}</strong>);
    } else {
      nodes.push(<em key={nextKey()}>{renderInline(token.slice(1, -1))}</em>);
    }
    rest = rest.slice(m.index + token.length);
  }
  return nodes;
}

/** Split the message into block-level elements. */
function renderBlocks(src: string): React.ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — skip.
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block.
    if (line.trim().startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre key={nextKey()}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${Math.min(level + 1, 6)}` as keyof JSX.IntrinsicElements;
      blocks.push(<Tag key={nextKey()}>{renderInline(heading[2])}</Tag>);
      i++;
      continue;
    }

    // Blockquote.
    if (line.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(<blockquote key={nextKey()}>{renderBlocks(quote.join('\n'))}</blockquote>);
      continue;
    }

    // Unordered list.
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={nextKey()}>
          {items.map((it) => (
            <li key={nextKey()}>{renderInline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={nextKey()}>
          {items.map((it) => (
            <li key={nextKey()}>{renderInline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph — gather consecutive non-blank, non-special lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith('```') &&
      !/^#{1,4}\s+/.test(lines[i]) &&
      !lines[i].startsWith('>') &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={nextKey()}>
        {para.map((ln, idx) => (
          <React.Fragment key={idx}>
            {idx > 0 && <br />}
            {renderInline(ln)}
          </React.Fragment>
        ))}
      </p>,
    );
  }

  return blocks;
}

const Markdown: React.FC<{ children: string }> = ({ children }) => {
  return <div className='markdown'>{renderBlocks(children)}</div>;
};

export default Markdown;
