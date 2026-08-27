import React, { useState } from 'react';
import { copyToClipboard } from '../utils/clipboard';

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

  return (
    <div className='code-block'>
      <div className='code-block-header'>
        <span className='code-block-lang'>{language || 'text'}</span>
        <button type='button' className='code-block-copy' onClick={handleCopy}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  );
};

export default CodeBlock;
