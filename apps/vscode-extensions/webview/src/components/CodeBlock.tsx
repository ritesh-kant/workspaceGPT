import React, { useState } from 'react';
import { copyToClipboard } from '../utils/clipboard';
import { isDesktopHost } from '../vscode';

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'terminal']);

// The desktop shell page owns the terminal; it listens for this on window.parent.
export const RUN_IN_TERMINAL = 'wgpt:run-in-terminal';

type CodeBlockProps = React.ComponentPropsWithoutRef<'pre'>;

function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement(node)) return extractText((node.props as { children?: React.ReactNode })?.children);
  return '';
}

function extractLanguage(children: React.ReactNode): string | null {
  const codeEl = Array.isArray(children) ? children[0] : children;
  if (React.isValidElement(codeEl)) {
    const className = (codeEl.props as { className?: string })?.className;
    const match = className?.match(/language-(\S+)/);
    return match ? match[1] : null;
  }
  return null;
}

/**
 * react-markdown's `pre` renderer for fenced code blocks. Adds a language
 * label and a copy button — syntax highlighting itself comes from
 * rehype-highlight (see ChatMessage.tsx), which has already turned the code
 * into highlighted spans by the time this renders `children`.
 */
const CodeBlock: React.FC<CodeBlockProps> = ({ children, ...rest }) => {
  const [copied, setCopied] = useState(false);
  const language = extractLanguage(children);

  const handleCopy = async () => {
    const text = extractText(children);
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleRun = () => {
    const command = extractText(children).trim().replace(/^\$ /, '');
    if (command) window.parent.postMessage({ type: RUN_IN_TERMINAL, command }, '*');
  };
  const canRun = isDesktopHost() && !!language && SHELL_LANGS.has(language.toLowerCase());

  // A one-line block wraps instead of scrolling sideways: nothing in it can
  // lose alignment, and a sentence fenced as `text` used to run off the card
  // with its tail hidden. Multi-line blocks (code, diagrams) keep exact layout.
  const singleLine = !extractText(children).trim().includes('\n');

  return (
    <div className={`code-block${singleLine ? ' code-block--wrap' : ''}`}>
      <div className='code-block-header'>
        <span className='code-block-lang'>{language || 'text'}</span>
        {canRun && (
          <button type='button' className='code-block-copy code-block-run' title='Run in terminal' onClick={handleRun}>
            ▶ Run
          </button>
        )}
        <button type='button' className='code-block-copy' onClick={handleCopy}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  );
};

export default CodeBlock;
