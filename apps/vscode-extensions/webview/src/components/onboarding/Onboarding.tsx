import React, { useEffect, useRef, useState } from 'react';
// ModelSettings (rendered as an onboarding step below) relies on Settings.css
// for its form/button/status classes — imported explicitly here so
// onboarding doesn't depend on Settings.tsx happening to load first.
import { BRAND_ICON } from '../../assets/brandIcon';
import '../Settings.css';
import './Onboarding.css';
import { useSettingsStore, useSelectedModelProvider } from '../../store';
import { VSCodeAPI } from '../../vscode';
import { COPILOT_PROVIDER, MESSAGE_TYPES, WorkspaceMode } from '../../constants';
import { handleConfluenceActions } from '../settings/utils';
import ModelSettings from '../settings/ModelSettings';
import RemoteAccountSettings from '../settings/RemoteAccountSettings';
import { SettingsLayoutContext } from '../settings/SectionShell';

interface OnboardingProps {
  /** Called once the user finishes (or skips through) the flow. */
  onFinish: () => void;
}

type SetupChoice = WorkspaceMode | 'copilot';

const MODE_COPY: Record<SetupChoice, { title: string; description: string; detail: string }> = {
  remote: {
    title: 'Let WorkspaceGPT handle it',
    description: 'Managed models, without API keys or installation.',
    detail: 'Cloud inference · GitHub sign-in',
  },
  copilot: {
    title: 'Use GitHub Copilot',
    description: 'Connect your Copilot account. No model API key needed.',
    detail: 'Cloud inference · Uses your Copilot allowance',
  },
  local: {
    title: 'Use my own model',
    description: 'Run offline with Ollama, or use your own provider.',
    detail: 'Your choice of model · No WorkspaceGPT account',
  },
};

const SetupIcon: React.FC<{ kind: 'spark' | 'cloud' | 'device' | 'book' | 'copilot' }> = ({ kind }) => (
  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.5' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>
    {kind === 'spark' && <path d='m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z' />}
    {kind === 'cloud' && <path d='M7 18a5 5 0 0 1-1-9.9A6 6 0 0 1 17.5 8 5 5 0 0 1 18 18H7Z' />}
    {kind === 'device' && <><rect x='3' y='4' width='18' height='13' rx='2' /><path d='M8 21h8m-4-4v4m-4-12 2 2-2 2m5 0h3' /></>}
    {kind === 'copilot' && <><rect x='4' y='6' width='16' height='13' rx='5' /><path d='M9 11v3m6-3v3M8 6V3m8 3V3M4 12H2m18 0h2' /></>}
    {kind === 'book' && <><path d='M12 5v15M3 4c4-1 7 0 9 2 2-2 5-3 9-2v15c-4-1-7 0-9 2-2-2-5-3-9-2V4Z' /></>}
  </svg>
);

/**
 * First-run flow: pick a mode, configure that mode's engine, optionally
 * connect Confluence. Shown when `config.onboardingCompleted` is false (see
 * App.tsx) — a fresh install, or after Reset. Writing `mode` only happens on
 * Finish, so backing out mid-flow (e.g. a window reload) leaves the default
 * (`local`, incomplete) rather than a half-applied choice.
 */
const Onboarding: React.FC<OnboardingProps> = ({ onFinish }) => {
  const { config, setMode, setOnboardingCompleted, batchUpdateConfig } = useSettingsStore();
  const selectedModelProvider = useSelectedModelProvider();
  const vscode = VSCodeAPI();

  const headingRef = useRef<HTMLHeadingElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [setupChoice, setSetupChoice] = useState<SetupChoice>('remote');
  const chosenMode: WorkspaceMode = setupChoice === 'remote' ? 'remote' : 'local';
  const [confluenceConnecting, setConfluenceConnecting] = useState(false);
  const [confluenceStatus, setConfluenceStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [remoteSignedIn, setRemoteSignedIn] = useState(false);

  useEffect(() => {
    overlayRef.current?.scrollTo({ top: 0 });
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === MESSAGE_TYPES.CONFLUENCE_OAUTH_SUCCESS) {
        setConfluenceConnecting(false);
        batchUpdateConfig('confluence', {
          isAuthenticated: true,
          isConnecting: false,
          siteName: message.site?.name || '',
          cloudId: message.site?.id || '',
        });
        setConfluenceStatus({ ok: true, text: `Connected to ${message.site?.name || 'Confluence'}` });
      } else if (message.type === MESSAGE_TYPES.CONFLUENCE_OAUTH_ERROR) {
        setConfluenceConnecting(false);
        setConfluenceStatus({ ok: false, text: message.message || 'Authentication failed' });
      } else if (
        message.type === MESSAGE_TYPES.REMOTE_SESSION_STATUS ||
        message.type === MESSAGE_TYPES.REMOTE_SIGN_IN_SUCCESS
      ) {
        setRemoteSignedIn(!!message.signedIn || message.type === MESSAGE_TYPES.REMOTE_SIGN_IN_SUCCESS);
      } else if (message.type === MESSAGE_TYPES.REMOTE_SIGN_OUT_SUCCESS) {
        setRemoteSignedIn(false);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Remote mode has nothing to configure client-side: inference runs on the
  // WorkspaceGPT server, so signing in (RemoteAccountSettings, rendered below)
  // is the only remote-mode requirement. Embeddings and the index are local in
  // both modes, so neither mode asks for anything else here. Signing in is
  // mandatory to use remote mode, so there is no skip path.
  const engineReady = chosenMode === 'local'
    ? (setupChoice !== 'copilot' || selectedModelProvider.provider === COPILOT_PROVIDER) && !!selectedModelProvider.availableModels?.some((model) => model.id === selectedModelProvider.selectedModel)
    : remoteSignedIn;

  /**
   * Report an onboarding funnel milestone to the host (analytics only — never
   * carries user content). Without this the first-run drop-off is invisible:
   * a user can abandon model setup; these milestones distinguish incomplete setup
   * from a healthy install.
   */
  const trackOnboarding = (event: string, properties?: Record<string, unknown>) => {
    vscode.postMessage({ type: MESSAGE_TYPES.ONBOARDING_EVENT, event, properties });
  };

  // One event per step actually reached, so the funnel shows where users stop.
  useEffect(() => {
    trackOnboarding('onboarding_step_viewed', { step, mode: chosenMode });
  }, [step]);

  const connectConfluence = () => {
    setConfluenceStatus(null);
    setConfluenceConnecting(true);
    trackOnboarding('onboarding_confluence_connect_clicked', { mode: chosenMode });
    handleConfluenceActions.startOAuth(vscode);
  };

  const finish = (viaSkip: boolean) => {
    if (!engineReady) return;
    // `engineReady` is the difference between a finished setup and one that
    // looks finished but can't chat — record it alongside the completion.
    trackOnboarding('onboarding_completed', {
      mode: chosenMode,
      engineReady,
      confluenceConnected: !!config.confluence?.isAuthenticated,
      viaSkip,
    });
    setMode(chosenMode);
    setOnboardingCompleted(true);
    onFinish();
  };

  return (
    <div className='onboarding-overlay' ref={overlayRef}>
      <div className='onboarding-card'>
        <header className='onboarding-brand'>
          <img className='onboarding-brand-mark' src={BRAND_ICON} alt='' />
          <span>WorkspaceGPT</span>
          <span className='onboarding-brand-caption'>A little setup. A lot of context.</span>
        </header>
        <nav aria-label='Setup progress'>
          <ol className='onboarding-progress'>
            {['Choose your setup', 'Connect a model', 'Add Knowledge'].map((label, index) => (
              <li key={label} className={index <= step ? 'is-active' : ''} aria-current={index === step ? 'step' : undefined}>
                <span>{index < step ? '✓' : String(index + 1).padStart(2, '0')}</span>
                {label}
              </li>
            ))}
          </ol>
        </nav>
        <main className='onboarding-content' key={step}>
          <div className='onboarding-eyebrow'>
            {step === 0 ? 'YOUR NEXT IDEA STARTS HERE' : step === 1 ? 'MAKE IT YOURS' : 'OPTIONAL · YOUR TEAM’S CONTEXT'}
          </div>
          {step === 0 && (
            <>
              <h1 className='onboarding-title' ref={headingRef} tabIndex={-1}>Your code. Your context.<br /><span>One place to build.</span></h1>
              <p className='onboarding-subtitle'>Connect your code, docs, and tickets. Choose your model setup.</p>
              <div className='onboarding-mode-row' role='group' aria-label='Model setup'>
                {(['remote', 'copilot', 'local'] as SetupChoice[]).map((mode) => (
                  <button type='button' key={mode} aria-pressed={setupChoice === mode}
                    className={`onboarding-mode-card${setupChoice === mode ? ' onboarding-mode-card--active' : ''}`}
                    onClick={() => setSetupChoice(mode)}>
                    <span className='onboarding-option-icon'><SetupIcon kind={mode === 'remote' ? 'cloud' : mode === 'copilot' ? 'copilot' : 'device'} /></span>
                    <span className='onboarding-option-copy'>
                      <span className='onboarding-mode-title'>{MODE_COPY[mode].title}</span>
                      <span className='onboarding-mode-desc'>{MODE_COPY[mode].description}</span>
                      <span className='onboarding-mode-detail'>{MODE_COPY[mode].detail}</span>
                    </span>
                    <span className='onboarding-selection' aria-hidden='true'>{setupChoice === mode ? '✓' : ''}</span>
                  </button>
                ))}
              </div>
              <div className='onboarding-footer'>
                <span className='onboarding-footer-note'>You can change this in Settings.</span>
                <button type='button' className='primary-button' onClick={() => setStep(1)}>Continue <span aria-hidden='true'>→</span></button>
              </div>
            </>
          )}
          {step === 1 && (
            <>
              <h1 className='onboarding-title' ref={headingRef} tabIndex={-1}>{chosenMode === 'remote' ? 'One sign-in. Ready to build.' : setupChoice === 'copilot' ? 'Connect GitHub Copilot.' : 'Bring the model you love.'}</h1>
              <p className='onboarding-subtitle'>{chosenMode === 'remote'
                ? 'Use your GitHub account to sign in to WorkspaceGPT. We handle the model setup.'
                : setupChoice === 'copilot'
                  ? 'Use your own Copilot account for cloud inference. Requests count toward your plan’s usage limits.'
                  : 'Choose Ollama for offline inference, or connect your preferred cloud provider.'}</p>
              <div className={`onboarding-step-body${chosenMode === 'remote' ? ' onboarding-account' : ''}`}>
                <SettingsLayoutContext.Provider value={{ layout: 'page', pageTitle: chosenMode === 'local' ? 'Model' : 'Account' }}>
                  {chosenMode === 'local' ? <ModelSettings setupOnly preferCopilot={setupChoice === 'copilot'} /> : <RemoteAccountSettings />}
                </SettingsLayoutContext.Provider>
              </div>
              <p className='onboarding-privacy'>{chosenMode === 'remote'
                ? 'Your Knowledge index stays on this device. Prompts and relevant context are sent for cloud inference.'
                : setupChoice === 'copilot'
                  ? 'Your Knowledge index stays on this device. Prompts and relevant context are sent to GitHub Copilot for cloud inference.'
                : 'Your Knowledge index stays on this device. Ollama runs inference locally; cloud providers receive the context you send.'}</p>
              <div className='onboarding-footer'>
                <button type='button' className='onboarding-skip' onClick={() => setStep(0)}>← Back</button>
                <div className='onboarding-footer-right'>
                  <span className='onboarding-footer-note' role='status'>{engineReady ? 'Model connected' : chosenMode === 'remote' ? 'Sign in to continue' : 'Select a model to continue'}</span>
                  <button type='button' className='primary-button' disabled={!engineReady} onClick={() => setStep(2)}>Continue <span aria-hidden='true'>→</span></button>
                </div>
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <h1 className='onboarding-title' ref={headingRef} tabIndex={-1}>Give your agent<br /><span>the bigger picture.</span></h1>
              <p className='onboarding-subtitle'>Bring your team’s docs into the conversation. Connect Knowledge now, or start with your code and add it later.</p>
              <div className='onboarding-knowledge-card'>
                <span className='onboarding-option-icon'><SetupIcon kind='book' /></span>
                <div className='onboarding-option-copy'>
                  <h2>Confluence</h2>
                  <p>Design decisions, project docs, and answers grounded in your team’s work.</p>
                  {config.confluence?.isAuthenticated ? (
                    <div className='onboarding-connected' role='status'>✓ Connected to {config.confluence.siteName || 'Confluence'}</div>
                  ) : (
                    <button type='button' className='secondary-button' onClick={connectConfluence} disabled={confluenceConnecting}>
                      {confluenceConnecting ? 'Connecting…' : 'Connect Confluence'}
                    </button>
                  )}
                </div>
              </div>
              {confluenceStatus && !confluenceStatus.ok && <div className='status-message error' role='alert'>{confluenceStatus.text}</div>}
              <p className='onboarding-privacy'>Confluence, Jira, and Azure DevOps are available in Settings → Knowledge. Syncing and indexing happen on your device.</p>
              <div className='onboarding-footer'>
                <button type='button' className='onboarding-skip' onClick={() => setStep(1)}>← Back</button>
                <button type='button' className='primary-button' disabled={!engineReady || confluenceConnecting}
                  onClick={() => finish(!config.confluence?.isAuthenticated)}>
                  {config.confluence?.isAuthenticated ? 'Start building' : 'Start without Knowledge'} <span aria-hidden='true'>→</span>
                </button>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
};

export default Onboarding;
