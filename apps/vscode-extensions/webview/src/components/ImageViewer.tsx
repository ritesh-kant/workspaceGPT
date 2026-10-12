import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { copyImage, toPngBlob } from '../utils/imageCopy';

const MIN = 0.25;
const MAX = 8;

interface ViewerProps {
  src: string;
  alt?: string;
  /** What "Copy image" puts on the clipboard; defaults to the image itself. A diagram passes its light-theme export. */
  getPng?: () => Promise<Blob | null>;
  onClose: () => void;
}

/** Full-size view: wheel or +/− to zoom, drag to pan, double-click to reset, Esc to close. */
export const ImageViewer: React.FC<ViewerProps> = ({ src, alt, getPng, onClose }) => {
  const [scale, setScale] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const zoomBy = useCallback((f: number) => setScale((s) => Math.min(MAX, Math.max(MIN, s * f))), []);
  const reset = useCallback(() => {
    setScale(1);
    setPos({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') zoomBy(1.25);
      else if (e.key === '-') zoomBy(0.8);
      else if (e.key === '0') reset();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, zoomBy, reset]);

  const onCopy = async () => {
    const ok = await copyImage(getPng ? getPng() : toPngBlob(src));
    setCopied(ok ? 'ok' : 'fail');
    setTimeout(() => setCopied(null), 1800);
  };

  return createPortal(
    <div className="image-viewer" role="dialog" aria-label={alt || 'Image'} onClick={onClose}>
      <div className="image-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => zoomBy(0.8)} title="Zoom out (−)" aria-label="Zoom out">−</button>
        <span className="image-viewer-pct">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => zoomBy(1.25)} title="Zoom in (+)" aria-label="Zoom in">+</button>
        <button type="button" onClick={reset} title="Reset (0)">Reset</button>
        <button type="button" onClick={onCopy} title="Copy image to the clipboard">
          {copied === 'ok' ? '✓ Copied' : copied === 'fail' ? 'Copy unavailable here' : 'Copy image'}
        </button>
        <button type="button" onClick={onClose} title="Close (Esc)" aria-label="Close">✕</button>
      </div>
      <div
        className="image-viewer-stage"
        onWheel={(e) => zoomBy(e.deltaY < 0 ? 1.1 : 0.9)}
        onMouseDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
        }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (d) setPos({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={reset}
      >
        <img src={src} alt={alt ?? ''} draggable={false} style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})` }} />
      </div>
    </div>,
    document.body,
  );
};

/** An image that opens the viewer on click. Drop-in for <img>. */
export const ZoomableImage: React.FC<React.ImgHTMLAttributes<HTMLImageElement>> = ({ className, onClick, ...rest }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <img
        {...rest}
        className={`${className ?? ''} zoomable-image`.trim()}
        onClick={(e) => {
          onClick?.(e);
          if (rest.src) setOpen(true);
        }}
      />
      {open && rest.src && <ImageViewer src={rest.src} alt={rest.alt} onClose={() => setOpen(false)} />}
    </>
  );
};
