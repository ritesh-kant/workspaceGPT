import React, { useState } from 'react';
import { useEffect, useCallback } from 'react';
import { useModelActions, useSelectedModelProvider } from '../../store';
import { MESSAGE_TYPES, MODEL_PROVIDERS } from '../../constants';
import { changeProviderHandler, fetchAvailableModels } from './utils';

const ModelSettings: React.FC = () => {
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);

  const selectedModelProvider = useSelectedModelProvider();

  const {
    updateSelectedModelProvider,
    handleModelChange,
    updateModelProvider,
  } = useModelActions();


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
    // Fetch available models for the selected provider whenever component mounts or selectedProvider changes
    fetchAvailableModels(
      selectedModelProvider.provider,
      selectedModelProvider.apiKey
    );
  }, []);
  useEffect(() => {
    // Listen for model configuration and sync updates from extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      switch (message.type) {
        case MESSAGE_TYPES.FETCH_AVAILABLE_MODELS_RESPONSE:
          const fetchedModels = message.models;
          let newSelectedModel = selectedModelProvider.selectedModel;

          if (fetchedModels && fetchedModels.length > 0) {
            if (!newSelectedModel || !fetchedModels.find((m: any) => m.id === newSelectedModel)) {
              newSelectedModel = fetchedModels[0].id;
            }
          }

          updateModelProvider(
            selectedModelProvider.provider,
            'availableModels',
            fetchedModels
          );

          if (newSelectedModel !== selectedModelProvider.selectedModel) {
            updateModelProvider(
              selectedModelProvider.provider,
              'selectedModel',
              newSelectedModel
            );
          }

          // Ensure selectedModelProvider state is also updated
          updateSelectedModelProvider({
            ...selectedModelProvider,
            availableModels: fetchedModels,
            selectedModel: newSelectedModel,
          });
          setApiKeyError(null);
          break;
        case MESSAGE_TYPES.FETCH_AVAILABLE_MODELS_ERROR:
          updateModelProvider(
            selectedModelProvider.provider,
            'availableModels',
            message.models // Assuming message.models is an empty array on error
          );
          // Ensure selectedModelProvider state is also updated
          updateSelectedModelProvider({
            ...selectedModelProvider,
            availableModels: message.models, // Or [] if message.models could be undefined
          });
          setApiKeyError(message.message);
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [selectedModelProvider]);

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
            onChange={(e) => changeProviderHandler(e.target.value)}
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
                value={selectedModelProvider?.apiKey ?? ''}
                onChange={(e) => {
                  const newApiKey = e.target.value;
                  // Update the API key immediately in the UI
                  updateModelProvider(
                    selectedModelProvider.provider,
                    'apiKey',
                    newApiKey
                  );
                  updateSelectedModelProvider({
                    ...selectedModelProvider,
                    apiKey: newApiKey,
                  });
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

        {showSelectModelValidator() && (
          <div className='form-group'>
            <label htmlFor='model-select'>Select Model</label>
            <select
              id='model-select'
              className='select-larger'
              value={selectedModelProvider?.selectedModel}
              onChange={(e) =>
                handleModelChange(
                  e.target.value,
                  selectedModelProvider.provider
                )
              }
            >
              {selectedModelProvider?.availableModels &&
                // Render options from available models
                selectedModelProvider.availableModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
            </select>
          </div>
        )}
      </div>
    </div>
  );

  function showSelectModelValidator() {
    return (
      !apiKeyError &&
      selectedModelProvider?.apiKey &&
      (selectedModelProvider?.availableModels?.length ?? 0) > 0
    );
  }
};

export default ModelSettings;
