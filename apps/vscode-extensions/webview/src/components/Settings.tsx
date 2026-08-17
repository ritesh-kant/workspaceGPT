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
    () => !!(config.ado?.isAdoEnabled || config.deployment?.isDeploymentEnabled)
  );

  // If either beta feature is already enabled (e.g. settings finish loading
  // after this component mounts), expand the section so it isn't hidden.
  useEffect(() => {
    if (config.ado?.isAdoEnabled || config.deployment?.isDeploymentEnabled) {
      setIsBetaOpen(true);
    }
  }, [config.ado?.isAdoEnabled, config.deployment?.isDeploymentEnabled]);

  function reset() {
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
    clearStatusMessageAfterDelay('confluence', 'statusMessage');
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

        <ConfluenceSettings />

        <div className='beta-section'>
          <div
            className='beta-section-header'
            onClick={() => setIsBetaOpen((open) => !open)}
          >
            <h3>
              Beta Features <span className='beta-badge'>Beta</span>
            </h3>
            <span className='trigger-arrow'>{isBetaOpen ? '▲' : '▼'}</span>
          </div>
          {isBetaOpen && (
            <div className='beta-section-body'>
              <AdoSettings />
              <DeploymentSettings />
            </div>
          )}
        </div>

        <McpSettings />

        {/* <CodebaseSettings /> */}

        <div className='settings-form'>
          <button className='secondary-button' onClick={() => reset()}>
            Reset WorkspaceGPT
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsButton;
