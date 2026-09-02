import React, { useState } from 'react';
import { useEffect, useCallback } from 'react';
import { useModelActions, useSelectedModelProvider } from '../../store';
import { MESSAGE_TYPES, MODEL_PROVIDERS } from '../../constants';
import { changeProviderHandler, fetchAvailableModels } from './utils';
import SearchableDropdown from './SearchableDropdown';
import SectionShell from './SectionShell';

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
      fetchAvailableModels(selectedModelProvider.provider, apiKey, selectedModelProvider.baseUrl);
    }, 500),
    [selectedModelProvider.provider, selectedModelProvider.baseUrl]
  );

  const isCustomProvider = selectedModelProvider.provider === 'Custom';

  const updateBaseUrl = (value: string) => {
    updateModelProvider(selectedModelProvider.provider, 'baseUrl', value);
    updateSelectedModelProvider({ ...selectedModelProvider, baseUrl: value });
    if (selectedModelProvider.apiKey) {
      debouncedFetchModels(selectedModelProvider.apiKey);
    }
  };

  // The configured keys for this provider (falls back to the legacy single key).
  const apiKeys: string[] =
    selectedModelProvider.apiKeys && selectedModelProvider.apiKeys.length > 0
      ? selectedModelProvider.apiKeys
      : [selectedModelProvider.apiKey ?? ''];
  const configuredKeyCount = apiKeys.filter((k) => k.trim()).length;

  // Persist a new key list, keeping apiKey synced to the first entry. The first
  // (primary) key is what model-listing validates and the failover order head.
  const setApiKeys = (keys: string[]) => {
    const primary = keys[0] ?? '';
    updateModelProvider(selectedModelProvider.provider, 'apiKeys', keys);
    updateModelProvider(selectedModelProvider.provider, 'apiKey', primary);
    updateSelectedModelProvider({ ...selectedModelProvider, apiKeys: keys, apiKey: primary });
    debouncedFetchModels(primary);
  };

  const updateApiKeyAt = (i: number, value: string) =>
    setApiKeys(apiKeys.map((k, idx) => (idx === i ? value : k)));
  const addApiKey = () => setApiKeys([...apiKeys, '']);
  const removeApiKeyAt = (i: number) => {
    const next = apiKeys.filter((_, idx) => idx !== i);
    setApiKeys(next.length ? next : ['']);
  };

  // Pasting a comma-separated list of keys expands into one row per key,
  // in place of whichever row received the paste.
  const handleKeyPaste = (i: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    const parts = pasted
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (parts.length <= 1) return;
    e.preventDefault();
    const next = [...apiKeys];
    next.splice(i, 1, ...parts);
    setApiKeys(next);
  };

  useEffect(() => {
    // Fetch available models for the selected provider whenever component mounts or selectedProvider changes
    fetchAvailableModels(
      selectedModelProvider.provider,
      selectedModelProvider.apiKey,
      selectedModelProvider.baseUrl
    );
  }, []);
  useEffect(() => {
    // Listen for model configuration and sync updates from extension
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      // A model list only ever belongs to the provider it was fetched for.
      // Without this guard, switching providers mid-flight lands the old
      // provider's models on the new one — and the auto-select below then
      // picks a model that provider doesn't serve.
      const isForAnotherProvider =
        (message.type === MESSAGE_TYPES.FETCH_AVAILABLE_MODELS_RESPONSE ||
          message.type === MESSAGE_TYPES.FETCH_AVAILABLE_MODELS_ERROR) &&
        message.provider !== undefined &&
        message.provider !== selectedModelProvider.provider;
      if (isForAnotherProvider) return;

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
            message.models ?? []
          );
          // Ensure selectedModelProvider state is also updated
          updateSelectedModelProvider({
            ...selectedModelProvider,
            availableModels: message.models ?? [],
          });
          setApiKeyError(message.message);
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [selectedModelProvider]);

  const summary = apiKeyError
    ? '⚠️ Check API key'
    : configuredKeyCount === 0
      ? 'No API key set'
      : `${selectedModelProvider.provider}${selectedModelProvider.selectedModel ? ` · ${selectedModelProvider.selectedModel}` : ' · no model selected'}`;

  return (
    <SectionShell
      storageKey='model'
      title='Model'
      summary={summary}
      needsAttention={configuredKeyCount === 0 || !!apiKeyError}
    >
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

        {isCustomProvider && (
          <div className='form-group'>
            <label htmlFor='base-url'>Base URL</label>
            <input
              id='base-url'
              type='text'
              value={selectedModelProvider.baseUrl ?? ''}
              onChange={(e) => updateBaseUrl(e.target.value)}
              placeholder='https://your-endpoint.example.com/v1'
            />
            <small className='form-text'>
              Any OpenAI-compatible endpoint (self-hosted, proxy, etc.).
            </small>
          </div>
        )}

        {/* Show API Key input field if the selected provider requires it */}
        {MODEL_PROVIDERS.find(
          (provider) =>
            provider.MODEL_PROVIDER === selectedModelProvider.provider &&
            provider.requireApiKey
        ) && (
            <div className='form-group'>
              <details className='dep-details'>
                <summary>
                  API Key(s) · {configuredKeyCount} configured
                </summary>
                <div className='dep-details-body'>
                  {apiKeys.map((key, i) => (
                    <div key={i} className='api-key-row'>
                      <input
                        id={i === 0 ? 'api-key' : undefined}
                        type='password'
                        value={key}
                        onChange={(e) => updateApiKeyAt(i, e.target.value)}
                        onPaste={(e) => handleKeyPaste(i, e)}
                        placeholder={i === 0 ? 'Enter your API key' : `Fallback key #${i + 1}`}
                      />
                      {apiKeys.length > 1 && (
                        <button
                          type='button'
                          className='dep-icon-button dep-icon-danger'
                          onClick={() => removeApiKeyAt(i)}
                          data-tooltip='Remove key'
                          aria-label='Remove key'
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                  <button type='button' className='add-key-button' onClick={addApiKey}>
                    + Add API key
                  </button>
                  <small className='form-text'>
                    Required for {selectedModelProvider.provider} integration. Extra keys are
                    tried in order if one is rate-limited (HTTP 429). Paste a
                    comma-separated list into any field to add them all at once.
                  </small>
                  {apiKeyError && (
                    <small className='form-text error-message'>{apiKeyError}</small>
                  )}
                </div>
              </details>
            </div>
          )}

        {showSelectModelValidator() && (
          <div className='form-group'>
            <label htmlFor='model-select'>Select Model</label>
            <SearchableDropdown
              value={selectedModelProvider?.selectedModel ?? ''}
              options={(selectedModelProvider?.availableModels ?? []).map((model) => ({
                value: model.id,
                label: model.id,
              }))}
              onChange={(modelId) =>
                handleModelChange(modelId, selectedModelProvider.provider)
              }
              searchPlaceholder='Search models...'
              placeholder='-- Select a model --'
            />
          </div>
        )}

        {showSelectModelValidator() && (
          <div className='form-group'>
            <label htmlFor='agent-model-select'>Model for agent runs (optional)</label>
            <SearchableDropdown
              value={selectedModelProvider?.agentModel ?? ''}
              options={[
                { value: '', label: 'Same as above' },
                ...(selectedModelProvider?.availableModels ?? []).map((model) => ({ value: model.id, label: model.id })),
              ]}
              onChange={(modelId) => {
                const next = modelId || undefined;
                updateModelProvider(selectedModelProvider.provider, 'agentModel', next);
                updateSelectedModelProvider({ ...selectedModelProvider, agentModel: next });
              }}
              searchPlaceholder='Search models...'
              placeholder='Same as above'
            />
            <small className='form-text'>
              Autonomous ticket runs and Agent-mode turns use this model; ordinary chat keeps the one above.
              A stronger model here is what moves ticket-run quality most.
            </small>
          </div>
        )}
      </div>
    </SectionShell>
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
