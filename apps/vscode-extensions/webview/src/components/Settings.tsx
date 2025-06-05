import React, { useEffect } from 'react';
import { clearVSCodeState } from '../vscode';
import './Settings.css';
import { useSettingsStore, useChatStore, useModelActions } from '../store';
import { MESSAGE_TYPES } from '../constants';
import { clearStatusMessageAfterDelay } from './settings/utils';
import ModelSettings from './settings/ModelSettings';
import ConfluenceSettings from './settings/ConfluenceSettings';
import CodebaseSettings from './settings/CodebaseSettings';
import { SettingsButtonProps } from '../types';

const SettingsButton: React.FC<SettingsButtonProps> = ({
  isVisible,
  onBack,
}) => {
  const {
    setConfig,
    batchUpdateConfig,
    resetStore: resetSettingStore,
  } = useSettingsStore();

  const { resetStore: resetModelStore } = useModelActions();
  const { resetStore: resetChatStore } = useChatStore();


  useEffect(() => {

    // Listen for configuration and sync updates from extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      switch (message.type) {
        case 'SettingsButtonConfig':
          setConfig(message.config);
          break;
        // Codebase
        case MESSAGE_TYPES.SYNC_CODEBASE_IN_PROGRESS:
          batchUpdateConfig('codebase', {
            codebaseSyncProgress: message.progress,
            messageType: 'success',
            isSyncing: message.progress < 100,
            canResume: true,
          });
          break;

        case MESSAGE_TYPES.SYNC_CODEBASE_COMPLETE:
          batchUpdateConfig('codebase', {
            isSyncing: false,
            codebaseSyncProgress: 100,
            messageType: 'success',
            statusMessage: 'Sync completed successfully',
            canResume: false,
            isSyncCompleted: true,
          });
          clearStatusMessageAfterDelay(
            'codebase',
            'statusMessage',
          );
          break;

        case MESSAGE_TYPES.SYNC_CODEBASE_ERROR:
          batchUpdateConfig('codebase', {
            isSyncing: false,
            messageType: 'error',
            statusMessage: `Sync error: ${message.message}`,
            canResume: true,
          });
          break;

        case MESSAGE_TYPES.CODEBASE_CONNECTION_STATUS:
          batchUpdateConfig('codebase', {
            messageType: message.status ? 'success' : 'error',
            statusMessage: message.message || '',
          });
          clearStatusMessageAfterDelay(
            'codebase',
            'statusMessage',
          );
          break;

        // Codebase Indexing
        case MESSAGE_TYPES.INDEXING_CODEBASE_IN_PROGRESS:
          batchUpdateConfig('codebase', {
            codebaseIndexProgress: message.progress,
            messageType: 'success',
            isIndexing: message.progress < 100,
            canResumeIndexing: true,
            isSyncing: false,
            canResume: false,
          });
          break;

        case MESSAGE_TYPES.INDEXING_CODEBASE_COMPLETE:
          batchUpdateConfig('codebase', {
            codebaseIndexProgress: 100,
            messageType: 'success',
            isIndexing: false,
            statusMessage: 'Indexing completed successfully',
            canResumeIndexing: false,
            isSyncing: false,
            canResume: false,
            isIndexingCompleted: true,
          });
          clearStatusMessageAfterDelay(
            'codebase',
            'statusMessage',
          );
          break;

        case MESSAGE_TYPES.INDEXING_CODEBASE_ERROR:
          batchUpdateConfig('codebase', {
            isSyncing: false,
            messageType: 'error',
            statusMessage: `Indexing error: ${message.message}`,
            canResumeIndexing: true,
          });
          break;

        // Handle workspace path response
        case MESSAGE_TYPES.WORKSPACE_PATH:
          if (message.path) {
            batchUpdateConfig('codebase', {
              repoPath: message.path,
            });
          }
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

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

      <ModelSettings />
      <br />

      <ConfluenceSettings />
      <br />

      <CodebaseSettings />
      <br />

      <div className='settings-form'>
        <button className='secondary-button' onClick={() => reset()}>
          Reset WorkspaceGPT
        </button>
      </div>
    </div>
  );
};

export default SettingsButton;
