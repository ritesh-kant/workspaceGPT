/**
 * The site's icon set.
 *
 * These slots used to hold emoji. Emoji are rendered by the operating system,
 * so the same feature card shipped a flat outline on one machine, a glossy 3D
 * blob on another, and a tofu box where the font was missing — three different
 * brands for one product. These are stroke icons on a 24x24 grid drawn in
 * `currentColor`, so the parent's text color still picks the accent and every
 * visitor sees the same weight.
 */

export type IconName =
  | 'laptop'
  | 'trash'
  | 'eye-off'
  | 'lock'
  | 'zap'
  | 'sparkles'
  | 'file-text'
  | 'clipboard-list'
  | 'message-square';

/** Path geometry only — the <svg> wrapper below supplies the shared stroke. */
const PATHS: Record<IconName, React.ReactNode> = {
  laptop: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M2 20h20" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6 0 10 7 10 7a18.4 18.4 0 0 1-2.6 3.6" />
      <path d="M6.6 6.6A18.7 18.7 0 0 0 2 12s4 7 10 7a10.7 10.7 0 0 0 4.4-.9" />
      <path d="M14.1 14.1a3 3 0 1 1-4.2-4.2" />
      <path d="M2 2l20 20" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  zap: <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />,
  sparkles: (
    <>
      <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z" />
      <path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" />
    </>
  ),
  'file-text': (
    <>
      <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7l-5-5z" />
      <path d="M14 2v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h6" />
    </>
  ),
  'clipboard-list': (
    <>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M9 12h6" />
      <path d="M9 16h6" />
    </>
  ),
  'message-square': (
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  ),
};

export function Icon({
  name,
  size = 24,
  className = '',
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
