import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';

export interface DiagramPng {
  /** base64 PNG */
  png: string;
  width: number;
  height: number;
}

const MAX_SIDE = 4096;

/**
 * One mermaid source → a PNG, or null when anything on the way fails.
 *
 * Always the light theme on white: the image ends up on a Confluence page, not in this UI.
 * `htmlLabels: false` keeps labels as SVG text — a foreignObject would taint the canvas in
 * WebKit (the desktop app's engine) and the export would silently fail.
 */
export async function renderDiagramPng(source: string, seq: number): Promise<DiagramPng | null> {
  try {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', flowchart: { htmlLabels: false } });
    const { svg } = await mermaid.render(`wgpt-export-${Date.now()}-${seq}`, source);
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement;
    const vb = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
    if (vb.length !== 4 || !(vb[2] > 0) || !(vb[3] > 0)) return null;
    const [w, h] = [Math.ceil(vb[2]), Math.ceil(vb[3])];
    root.setAttribute('width', String(w));
    root.setAttribute('height', String(h));
    root.removeAttribute('style');
    const scale = Math.min(2, MAX_SIDE / Math.max(w, h));
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('svg did not load'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(root));
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = canvas.toDataURL('image/png').split(',')[1]; // throws if the canvas is tainted
    return png ? { png, width: w, height: h } : null;
  } catch {
    return null;
  }
}

/** Answers the host's RENDER_DIAGRAMS_REQUEST (the Confluence publish step attaches the images). */
export function installDiagramExport(): () => void {
  const onMessage = async (event: MessageEvent) => {
    const m = event.data;
    if (m?.type !== MESSAGE_TYPES.RENDER_DIAGRAMS_REQUEST || !Array.isArray(m.sources)) return;
    const images: (DiagramPng | null)[] = [];
    for (const [i, src] of (m.sources as string[]).entries()) images.push(await renderDiagramPng(String(src), i));
    VSCodeAPI().postMessage({ type: MESSAGE_TYPES.RENDER_DIAGRAMS_RESPONSE, id: m.id, images });
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
