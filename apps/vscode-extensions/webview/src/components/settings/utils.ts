import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES } from '../../constants';
import { useSettingsStore } from '../../store';

export const clearStatusMessageAfterDelay = (
  section: 'confluence' | 'codebase',
  field: 'statusMessage' | 'messageType',
  value?: string | 'unknown',
  delay: number = 2000
) => {
  setTimeout(() => {
    const batchUpdateConfig = useSettingsStore.getState().batchUpdateConfig
    batchUpdateConfig(section, {
      [field]: value,
    });
  }, delay);
};


export const handleConfluenceActions = {
  checkConnection: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.CHECK_CONFLUENCE_CONNECTION,
      section: 'confluence',
      config,
    });
  },

  startSync: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.START_CONFLUENCE_SYNC,
      section: 'confluence',
      config,
    });
  },

  resumeSync: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.RESUME_CONFLUENCE_SYNC,
      section: 'confluence',
      config,
    });
  },

  stopSync: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.STOP_CONFLUENCE_SYNC,
      section: 'confluence',
      config,
    });
  },
};

export const handleCodebaseActions = {
  startSync: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.START_CODEBASE_SYNC,
      section: 'codebase',
      config,
    });
  },

  resumeSync: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.RESUME_CODEBASE_SYNC,
      section: 'codebase',
      config,
    });
  },

  resumeIndexing: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.RESUME_INDEXING_CODEBASE,
      section: 'codebase',
      config,
    });
  },

  stopSync: (vscode: ReturnType<typeof VSCodeAPI>, config: any) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.STOP_CODEBASE_SYNC,
      section: 'codebase',
      config,
    });
  },
};
export const handleInputChange = (
  section: 'confluence' | 'codebase',
  field: string,
  value: string
) => {
  console.log('handleInputChange', section, field, value);
  const setConfig = useSettingsStore.getState().setConfig;
  const config = useSettingsStore.getState().config;
  const updatedConfig = {
    ...config,
    [section]: {
      ...config[section],
      [field]: value,
    },
  };
  setConfig(updatedConfig);
};