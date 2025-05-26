import React, { useState } from 'react';
import { useEffect, useCallback } from 'react';
import {
  useModelActions,
  useModelProviders,
  useSelectedModelProvider,
} from '../../store';
import { MESSAGE_TYPES, MODEL_PROVIDERS } from '../../constants';
import { VSCodeAPI } from '../../vscode';

const ModelSettings: React.FC = () => {
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);

  const modelProviders = useModelProviders();

  const selectedModelProvider = useSelectedModelProvider();

  const {
    updateSelectedModelProvider,
    handleModelChange,
    handleProviderChange,
    updateModelProvider,
  } = useModelActions();

  console.log('=====modelConfig: modelProviders', modelProviders);
  console.log('=====modelConfig: selectedProvider', selectedModelProvider);
  const modelConfig = modelProviders[selectedModelProvider.providerIndex];
  const providerIndex = selectedModelProvider.providerIndex;

  const vscode = VSCodeAPI();

  // Debounce function implementation
  const debounce = (func: Function, wait: number) => {
    let timeout: NodeJS.Timeout;
    return (...args: any[]) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), wait);
    };
  };

  // Create a debounced version of fetchAvailableModels
  const debouncedFetchModels = useCallback(
    debounce((apiKey: string) => {
      fetchAvailableModels(selectedModelProvider.provider, apiKey);
    }, 500),
    [selectedModelProvider.provider]
  );

  useEffect(() => {
    // Listen for model configuration and sync updates from extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      switch (message.type) {
        case MESSAGE_TYPES.FETCH_AVAILABLE_MODELS_RESPONSE:
          updateModelProvider(
            selectedModelProvider.providerIndex,
            'availableModels',
            message.models
          );
          setApiKeyError(null);
          break;
        case MESSAGE_TYPES.FETCH_AVAILABLE_MODELS_ERROR:
          updateModelProvider(
            selectedModelProvider.providerIndex,
            'availableModels',
            message.models
          );
          setApiKeyError(message.message);
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [selectedModelProvider]);

  const retry = () => {
    vscode.postMessage({
      type: MESSAGE_TYPES.RETRY_OLLAMA_CHECK,
    });
  };

  // Modified to accept providerName and apiKey
  const fetchAvailableModels = (providerName: string, apiKeyToUse?: string) => {
    vscode.postMessage({
      type: MESSAGE_TYPES.FETCH_AVAILABLE_MODELS,
      provider: providerName,
      apiKey: apiKeyToUse,
    });
  };

  return (
    <div className='settings-section'>
      <div className='section-header'>
        <h3>Model Settings</h3>
      </div>
      <div className='settings-form'>
        <div className='form-group'>
          <label htmlFor='provider-select'>Select Provider</label>
          <select
            id='provider-select'
            className='select-larger'
            value={selectedModelProvider.provider}
            onChange={(e) => {
              const newProviderName = e.target.value;

              const newProviderIndex = MODEL_PROVIDERS.findIndex(
                (p) => p.MODEL_PROVIDER === newProviderName
              );

              // Update the global selectedModelProvider state
              updateSelectedModelProvider({
                provider: newProviderName,
                providerIndex: newProviderIndex,
              });
              // This console.log will show the *old* value of selectedModelProvider due to async state updates
              console.log(
                'Selected provider (old value): ',
                selectedModelProvider
              );

              // Call handleProviderChange with the newProviderIndex to update the specific modelConfig
              handleProviderChange(newProviderIndex, newProviderName);

              // Fetch available models for the NEW provider using its API key
              // Note: modelProviders from the store might not be instantly updated if handleProviderChange is also async.
              // Assuming modelProviders[newProviderIndex] gives the current config for that slot.
              const apiKeyForNewProvider =
                modelProviders[newProviderIndex]?.apiKey;

              fetchAvailableModels(newProviderName, apiKeyForNewProvider);

              // Ensure local modelConfig's availableModels and selectedModel are cleared for the UI
              // batchUpdateModelProvider(newProviderIndex, {
              //   availableModels: [],
              //   selectedModel: undefined,
              // });
            }}
          >
            {MODEL_PROVIDERS.map((provider) => (
              <option
                key={provider.MODEL_PROVIDER}
                value={provider.MODEL_PROVIDER}
              >
                {provider.MODEL_PROVIDER}
              </option>
            ))}
          </select>
        </div>

        {/* Show API Key input field if the selected provider requires it */}
        {MODEL_PROVIDERS.find(
          (provider) =>
            provider.MODEL_PROVIDER === selectedModelProvider.provider &&
            provider.requireApiKey
        ) && (
          <div className='form-group'>
            <label htmlFor='api-key'>API Key</label>
            <input
              id='api-key'
              type='password'
              value={modelConfig?.apiKey}
              onChange={(e) => {
                const newApiKey = e.target.value;
                // Update the API key immediately in the UI
                updateModelProvider(
                  selectedModelProvider.providerIndex,
                  'apiKey',
                  newApiKey
                );
                // Debounce the API call
                debouncedFetchModels(newApiKey);
              }}
              placeholder='Enter your API key'
            />
            <small className='form-text'>
              Required for {selectedModelProvider.provider} integration
            </small>
            {apiKeyError && (
              <small className='form-text error-message'>{apiKeyError}</small>
            )}
          </div>
        )}

        {!apiKeyError && (
          <div className='form-group'>
            <label htmlFor='model-select'>Select Model</label>
            <select
              id='model-select'
              className='select-larger'
              value={modelConfig?.selectedModel}
              onChange={(e) => handleModelChange(providerIndex, e.target.value)}
              disabled={modelConfig?.isDownloading}
            >
              {modelConfig?.availableModels &&
                // Render options from available models
                modelConfig.availableModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
            </select>
            {modelConfig?.isDownloading && (
              <div className='model-download-status'>
                <div className='progress-bar'>
                  <div
                    className='progress-fill'
                    style={{
                      width: `${modelConfig.downloadProgress}%`,
                    }}
                  ></div>
                </div>
              </div>
            )}
            {modelConfig?.downloadStatus === 'error' && (
              <div className='error-message'>
                Failed to download model &nbsp;
                <button
                  onClick={() => retry()}
                  className='retry-button'
                  title='Retry connection'
                >
                  ↻
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ModelSettings;
