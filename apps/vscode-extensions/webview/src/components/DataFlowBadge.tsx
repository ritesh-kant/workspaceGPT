import { COPILOT_PROVIDER } from '../constants';

interface DataFlowBadgeProps {
  mode: 'local' | 'remote';
  /** The selected model provider's name (local mode); ignored in remote mode. */
  provider?: string;
  /** User-supplied URL of the 'Custom' provider, used to tell a loopback server from a hosted one. */
  baseUrl?: string;
}

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

/**
 * Where the next question and its retrieved snippets go. Indexing and the
 * search index are on-device in every mode, so this only describes inference.
 * Mirrors the table on the website's /trust page — keep the two in step.
 */
export function describeDataFlow({ mode, provider, baseUrl }: DataFlowBadgeProps) {
  if (mode === 'remote') {
    return {
      label: '→ WorkspaceGPT',
      local: false,
      detail:
        'Your question and the snippets retrieved for it go to the WorkspaceGPT endpoint and on to its model provider. They are processed in memory and not stored. Your index and documents never leave this machine.',
    };
  }
  const isLocalServer = provider === 'Ollama' || (provider === 'Custom' && !!baseUrl && LOOPBACK.test(baseUrl));
  if (isLocalServer) {
    return {
      label: 'Stays on device',
      local: true,
      detail: 'Your model runs on this machine. Nothing is sent anywhere.',
    };
  }
  const name = provider || 'your model provider';
  return {
    label: `→ ${name}`,
    local: false,
    detail:
      provider === COPILOT_PROVIDER
        ? 'Your question and the snippets retrieved for it go to GitHub Copilot, under your GitHub account and terms. They are not sent to WorkspaceGPT.'
        : `Your question and the snippets retrieved for it go straight from this machine to ${name}, under your own account with them. They are not sent to WorkspaceGPT.`,
  };
}

export default function DataFlowBadge(props: DataFlowBadgeProps) {
  const { label, detail, local } = describeDataFlow(props);
  return (
    <span
      className='data-flow-badge'
      data-local={local}
      data-tooltip={detail}
      aria-label={detail}
      tabIndex={0}
    >
      {label}
    </span>
  );
}
