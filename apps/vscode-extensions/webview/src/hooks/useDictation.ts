import { useCallback, useEffect, useRef, useState } from 'react';
import { isDesktopHost } from '../vscode';

export type DictationState = 'idle' | 'starting' | 'listening' | 'finishing';

/** What the mic button's tooltip shows for the toggle shortcut. */
export const DICTATION_SHORTCUT = /Mac/i.test(navigator.platform) ? '⌘⇧D' : 'Ctrl+Shift+D';

interface DictationBridge {
  available(): boolean;
  request(op: 'start' | 'stop' | 'cancel', locale?: string): void;
}

/** The desktop bridge's dictation hooks (apps/desktop/bridge/desktop-bridge.ts); absent in VS Code. */
const bridge = (): DictationBridge | undefined => (window as { __wgptBridge?: { dictation?: DictationBridge } }).__wgptBridge?.dictation;

/**
 * Dictation into the composer: the desktop host listens through the system's
 * speech recognition (apps/desktop/sidecar/host/dictation.ts) and this hook
 * writes what it hears into the text box where the caret was, as it hears it.
 *
 * `available` is false everywhere the host can't dictate, so the mic button
 * never shows in VS Code or on a platform without it.
 *
 * ⌘⇧D (Ctrl+Shift+D elsewhere) taps it on and off from the keyboard.
 *
 * Typing or sending while dictation runs ends it: the text on screen is then
 * the user's, and a late transcript must not overwrite it. Escape ends it and
 * puts back what the box held before.
 */
export function useDictation(inputRef: React.RefObject<HTMLTextAreaElement | null>, value: string, setValue: (value: string) => void) {
  const [available, setAvailable] = useState(() => isDesktopHost() && !!bridge()?.available());
  const [state, setState] = useState<DictationState>('idle');
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<DictationState>('idle');
  stateRef.current = state;
  // The text either side of where the dictation lands, and the last value this hook wrote.
  const around = useRef<{ before: string; after: string } | null>(null);
  const written = useRef<string | null>(null);

  const end = useCallback((restore: boolean) => {
    const a = around.current;
    bridge()?.request('cancel');
    around.current = null;
    written.current = null;
    setState('idle');
    if (restore && a) setValue(a.before + a.after);
  }, [setValue]);

  useEffect(() => {
    if (!isDesktopHost()) return;
    const onEvent = (e: Event) => {
      const event = (e as CustomEvent).detail as { type?: string; available?: boolean; state?: DictationState; text?: string; message?: string } | undefined;
      if (event?.type === 'capability') setAvailable(!!event.available);
      else if (event?.type === 'state' && event.state) {
        setState(event.state);
        if (event.state === 'idle') {
          around.current = null;
          written.current = null;
        }
      } else if ((event?.type === 'partial' || event?.type === 'final') && around.current) {
        const { before, after } = around.current;
        const heard = event.text ?? '';
        // Space it from the words either side, without doubling one already there.
        const lead = before && heard && !/\s$/.test(before) ? ' ' : '';
        const trail = after && heard && !/^\s/.test(after) ? ' ' : '';
        const next = before + lead + heard + trail + after;
        written.current = next;
        setValue(next);
        if (event.type === 'final') {
          const caret = (before + lead + heard).length;
          requestAnimationFrame(() => {
            inputRef.current?.focus();
            inputRef.current?.setSelectionRange(caret, caret);
          });
        }
      } else if (event?.type === 'error') setError(event.message ?? 'Dictation failed.');
    };
    window.addEventListener('wgpt-dictation', onEvent);
    return () => window.removeEventListener('wgpt-dictation', onEvent);
  }, [inputRef, setValue]);

  // The user typed, or the message was sent: the box is theirs now.
  useEffect(() => {
    if (stateRef.current !== 'idle' && written.current !== null && value !== written.current) end(false);
  }, [value, end]);

  useEffect(() => {
    if (state === 'idle') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, end]);

  useEffect(() => () => {
    if (stateRef.current !== 'idle') bridge()?.request('cancel');
  }, []);

  const toggle = useCallback(() => {
    const host = bridge();
    if (!host) return;
    if (stateRef.current === 'idle') {
      const el = inputRef.current;
      const text = el?.value ?? value;
      const start = el?.selectionStart ?? text.length;
      const stop = el?.selectionEnd ?? start;
      around.current = { before: text.slice(0, start), after: text.slice(stop) };
      written.current = text;
      setError(null);
      setState('starting');
      host.request('start', navigator.language);
    } else if (stateRef.current === 'listening') {
      setState('finishing');
      host.request('stop');
    } else end(false);
  }, [inputRef, value, end]);

  // The shortcut calls whichever toggle is current, so it doesn't re-bind on every keystroke.
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    if (!available) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === 'KeyD') {
        e.preventDefault();
        toggleRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [available]);

  return { available, state, error, toggle, dismissError: () => setError(null) };
}
