import React, { useEffect, useState } from 'react';
import { clearVSCodeState, VSCodeAPI } from '../vscode';
import './Settings.css';
import { useSettingsStore, useChatStore, useModelActions } from '../store';
import { MESSAGE_TYPES } from '../constants';
import { clearStatusMessageAfterDelay } from './settings/utils';
import ModeSelector from './settings/ModeSelector';
import ModelSettings from './settings/ModelSettings';
import RemoteEngineSettings from './settings/RemoteEngineSettings';
import ShareSettings from './settings/ShareSettings';
import ConfluenceSettings from './settings/ConfluenceSettings';
import AdoSettings from './settings/AdoSettings';
import WebSearchSettings from './settings/WebSearchSettings';
import DeploymentSettings from './settings/DeploymentSettings';
// import CodebaseSettings from './settings/CodebaseSettings';
import McpSettings from './settings/McpSettings';
import { SettingsButtonProps } from '../types';

const SettingsButton: React.FC<SettingsButtonProps> = ({
  isVisible,
  onBack,
}) => {
  const {
    config,
    batchUpdateConfig,
    resetStore: resetSettingStore,
  } = useSettingsStore();

  const { resetStore: resetModelStore } = useModelActions();
  const { resetStore: resetChatStore } = useChatStore();

  const vscode = VSCodeAPI();

  const isRemote = config.mode === 'remote';

  const [isBetaOpen, setIsBetaOpen] = useState(
    () => !!config.deployment?.isDeploymentEnabled
  );
  const [confirmingReset, setConfirmingReset] = useState(false);

  // If the beta feature is already enabled (e.g. settings finish loading
  // after this component mounts), expand the section so it isn't hidden.
  useEffect(() => {
    if (config.deployment?.isDeploymentEnabled) {
      setIsBetaOpen(true);
    }
  }, [config.deployment?.isDeploymentEnabled]);

  function reset() {
    setConfirmingReset(false);
    clearVSCodeState();
    // Reset all store states
    resetSettingStore();
    resetModelStore();
    resetChatStore();
    batchUpdateConfig('confluence', {
      messageType: 'success',
      statusMessage: 'VSCode state reset successfully',
    });
    // Clear the success message after 2 seconds
    clearStatusMessageAfterDelay('confluence');
    vscode.postMessage({
      type: MESSAGE_TYPES.RESET,
    });
  }
  if (!isVisible) return null;

  return (
    <div className='settings-panel'>
      <div className='settings-header'>
        <div className='header-with-back'>
          <button className='back-button' onClick={onBack} aria-label='Go back'>
            ←
          </button>
          <h3>Settings</h3>
        </div>
      </div>

      <div className='settings-stack'>
        <ModeSelector />

        {isRemote ? <RemoteEngineSettings /> : <ModelSettings />}

        {isRemote && <ShareSettings />}

        {/* The two knowledge sources sit together: ADO feeds "Your work" on the
            home view, so it is core surface area, not a beta experiment. */}
        <ConfluenceSettings />

        <AdoSettings />

        <WebSearchSettings />

        <div className='beta-section'>
          <button
            type='button'
            className='beta-section-header'
            onClick={() => setIsBetaOpen((open) => !open)}
            aria-expanded={isBetaOpen}
            aria-label='Beta features'
          >
            <h3>
              Beta Features <span className='beta-badge'>Beta</span>
            </h3>
            <span className='trigger-arrow'>{isBetaOpen ? '▲' : '▼'}</span>
          </button>
          {isBetaOpen && (
            <div className='beta-section-body'>
              <DeploymentSettings />
            </div>
          )}
        </div>

        <McpSettings />

        {/* <CodebaseSettings /> */}

        <div className='settings-form'>
          <button className='danger-button' onClick={() => setConfirmingReset(true)}>
            Reset WorkspaceGPT
          </button>
        </div>
      </div>

      {/* Reset wipes every connection, key, and chat with no undo — at least as
          consequential as switching modes, which has always confirmed. */}
      {confirmingReset && (
        <div className='mode-confirm-overlay' role='dialog' aria-modal='true'>
          <div className='mode-confirm-dialog'>
            <p>
              Reset WorkspaceGPT? This clears your connections, API keys, indexed
              sources, and chat history on this machine. It cannot be undone.
            </p>
            <div className='mode-confirm-actions'>
              <button
                type='button'
                className='secondary-button'
                onClick={() => setConfirmingReset(false)}
              >
                Cancel
              </button>
              <button type='button' className='danger-button' onClick={reset}>
                Reset everything
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsButton;
