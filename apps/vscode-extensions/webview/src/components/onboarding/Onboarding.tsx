import React, { useEffect, useState } from 'react';
// ModelSettings (rendered as an onboarding step below) relies on Settings.css
// for its form/button/status classes — imported explicitly here so
// onboarding doesn't depend on Settings.tsx happening to load first.
import '../Settings.css';
import './Onboarding.css';
import { useSettingsStore, useSelectedModelProvider } from '../../store';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES, WorkspaceMode } from '../../constants';
import { handleConfluenceActions } from '../settings/utils';
import ModelSettings from '../settings/ModelSettings';
import RemoteAccountSettings from '../settings/RemoteAccountSettings';

interface OnboardingProps {
  /** Called once the user finishes (or skips through) the flow. */
  onFinish: () => void;
}

const MODE_COPY: Record<WorkspaceMode, { title: string; description: string }> = {
  local: {
    title: 'Local',
    description:
      'Bring your own chat model — including Ollama, fully offline. Embeddings and the search index stay on this machine.',
  },
  remote: {
    title: 'Remote',
    description:
      'Managed chat models, no setup. Embeddings and the search index run in the cloud, and you can share your workspace to the Chrome extension.',
  },
};

const TOTAL_STEPS = 3;

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

  const [step, setStep] = useState(0);
  const [chosenMode, setChosenMode] = useState<WorkspaceMode>('local');
  const [confluenceConnecting, setConfluenceConnecting] = useState(false);
  const [confluenceStatus, setConfluenceStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [remoteSignedIn, setRemoteSignedIn] = useState(false);

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

  // Remote mode has nothing to configure client-side anymore — inference and
  // embeddings run on the WorkspaceGPT server, so signing in (RemoteAccountSettings,
  // rendered below) is the only remote-mode requirement. Signing in is
  // mandatory to use remote mode, so there is no skip path here.
  const engineReady = chosenMode === 'local' ? !!selectedModelProvider?.selectedModel : remoteSignedIn;

  /**
   * Report an onboarding funnel milestone to the host (analytics only — never
   * carries user content). Without this the first-run drop-off is invisible:
   * a user can skip engine setup and "Finish" with no usable model, landing in
   * a chat they cannot send from, and nothing distinguishes them from a healthy
   * install.
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
    <div className='onboarding-overlay'>
      <div className='onboarding-card'>
        <div className='onboarding-progress'>
          Step {step + 1} of {TOTAL_STEPS}
        </div>

        {step === 0 && (
          <>
            <h1 className='onboarding-title'>Welcome to WorkspaceGPT</h1>
            <p className='onboarding-subtitle'>How should it run?</p>
            <div className='onboarding-mode-row'>
              {(Object.keys(MODE_COPY) as WorkspaceMode[]).map((m) => (
                <button
                  type='button'
                  key={m}
                  className={`onboarding-mode-card${chosenMode === m ? ' onboarding-mode-card--active' : ''}`}
                  onClick={() => setChosenMode(m)}
                >
                  <span className='onboarding-mode-title'>{MODE_COPY[m].title}</span>
                  <span className='onboarding-mode-desc'>{MODE_COPY[m].description}</span>
                </button>
              ))}
            </div>
            <div className='onboarding-footer'>
              <span />
              <button type='button' className='primary-button' onClick={() => setStep(1)}>
                Continue
              </button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1 className='onboarding-title'>
              Set up {MODE_COPY[chosenMode].title.toLowerCase()} mode
            </h1>
            <p className='onboarding-subtitle'>
              {chosenMode === 'local'
                ? 'Pick a chat model. Ollama needs to be running locally; any cloud provider works too.'
                : 'Sign up with WorkspaceGPT to enable remote mode.'}
            </p>
            <div className='onboarding-step-body'>
              {chosenMode === 'local' ? <ModelSettings /> : <RemoteAccountSettings />}
            </div>
            <div className='onboarding-footer'>
              <button type='button' className='secondary-button' onClick={() => setStep(0)}>
                Back
              </button>
              <div className='onboarding-footer-right'>
                {chosenMode === 'local' && (
                  <button
                    type='button'
                    className='onboarding-skip'
                    onClick={() => {
                      // The highest-signal drop-off in the whole flow: skipping
                      // here leaves the install with no usable chat engine.
                      trackOnboarding('onboarding_engine_skipped', {
                        mode: chosenMode,
                        engineReady,
                      });
                      setStep(2);
                    }}
                  >
                    Skip for now
                  </button>
                )}
                <button
                  type='button'
                  className='primary-button'
                  disabled={!engineReady}
                  onClick={() => setStep(2)}
                >
                  Continue
                </button>
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className='onboarding-title'>Connect Confluence</h1>
            <p className='onboarding-subtitle'>
              Sync your team's Confluence space so WorkspaceGPT can answer questions from it.
              You can do this later from Settings too.
            </p>
            <div className='onboarding-step-body'>
              {config.confluence?.isAuthenticated ? (
                <div className='status-message success'>
                  ✅ Connected to {config.confluence.siteName || 'Confluence'}
                </div>
              ) : (
                <button
                  type='button'
                  className='primary-button-full'
                  onClick={connectConfluence}
                  disabled={confluenceConnecting}
                >
                  {confluenceConnecting ? '⏳ Connecting…' : '🔗 Connect to Confluence'}
                </button>
              )}
              {confluenceStatus && !confluenceStatus.ok && (
                <div className='status-message error' style={{ marginTop: '8px' }}>
                  ❌ {confluenceStatus.text}
                </div>
              )}
            </div>
            <div className='onboarding-footer'>
              <button type='button' className='secondary-button' onClick={() => setStep(1)}>
                Back
              </button>
              <div className='onboarding-footer-right'>
                <button type='button' className='onboarding-skip' onClick={() => finish(true)}>
                  Skip
                </button>
                <button type='button' className='primary-button' onClick={() => finish(false)}>
                  Finish
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default Onboarding;
