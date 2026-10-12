/**
 * Mermaid for the markdown preview, built as its own file (dist/bridge/mermaid.js)
 * and loaded by desktop-bridge.ts only when a preview actually has a diagram —
 * the library is large and most views never need it.
 *
 * securityLevel 'strict': the diagram source is the agent's output, so labels
 * are escaped and click handlers / raw HTML are not honoured.
 */
import mermaid from 'mermaid';

let seq = 0;

(window as unknown as { __wgptMermaid: unknown }).__wgptMermaid = {
  async render(src: string, dark: boolean): Promise<string> {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
    const { svg } = await mermaid.render(`wgpt-mermaid-${++seq}`, src);
    return svg;
  },
};
