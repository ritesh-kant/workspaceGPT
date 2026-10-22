import React, { useEffect, useState } from 'react';
import { copyToClipboard } from '../utils/clipboard';
import { isDesktopHost } from '../vscode';
import { ImageViewer } from './ImageViewer';
import { renderDiagramPng } from '../utils/diagramExport';

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
const PlainCodeBlock: React.FC<CodeBlockProps> = ({ children, ...rest }) => {
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
          <button type='button' className='code-block-copy code-block-run' title='Run in terminal' aria-label='Run in terminal' onClick={handleRun}>
            <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><path d='M8 5v14l11-7z' /></svg>
          </button>
        )}
        <button type='button' className='code-block-copy' title='Copy' aria-label='Copy' onClick={handleCopy}>
          {copied ? (
            <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><path d='M20 6L9 17l-5-5' /></svg>
          ) : (
            <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><rect x='9' y='9' width='11' height='11' rx='2' /><path d='M5 15V6a2 2 0 0 1 2-2h9' /></svg>
          )}
        </button>
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  );
};

/**
 * A ```mermaid block renders as a diagram. The library is loaded on first use
 * (it is large), and anything that fails — a half-streamed diagram, a syntax
 * error — falls back to the plain block, so the source is never lost.
 * securityLevel 'strict': the diagram text is model output.
 */
let mermaidSeq = 0;
const MermaidBlock: React.FC<CodeBlockProps> = (props) => {
  const source = extractText(props.children).trim();
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    // Debounced: while the answer streams the source changes every few tokens.
    const timer = setTimeout(async () => {
      try {
        const { default: mermaid } = await import('mermaid');
        const rgb = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.map(Number) ?? [255, 255, 255];
        const dark = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 128;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
        const out = await mermaid.render(`wgpt-mermaid-${++mermaidSeq}`, source);
        if (!cancelled) setSvg(out.svg);
      } catch {
        if (!cancelled) setSvg(null);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source]);
  const [open, setOpen] = useState(false);
  if (!svg) return <PlainCodeBlock {...props} />;
  // Zoom shows the in-theme SVG; Copy puts the light-theme PNG (what the Confluence page gets) on the clipboard.
  const getPng = async () => {
    const r = await renderDiagramPng(source, 0);
    if ('error' in r) return null;
    const bytes = Uint8Array.from(atob(r.png), (c) => c.charCodeAt(0));
    return new Blob([bytes], { type: 'image/png' });
  };
  return (
    <>
      <div
        className='mermaid-diagram zoomable-image'
        title='Click to zoom or copy'
        onClick={() => setOpen(true)}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {open && <ImageViewer src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)} alt='Diagram' getPng={getPng} onClose={() => setOpen(false)} />}
    </>
  );
};

const CodeBlock: React.FC<CodeBlockProps> = (props) =>
  extractLanguage(props.children)?.toLowerCase() === 'mermaid' ? <MermaidBlock {...props} /> : <PlainCodeBlock {...props} />;

export default CodeBlock;
