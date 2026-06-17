import React from 'react';
import { useSettingsStore } from '../../store';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES } from '../../constants';

/**
 * Share to Chrome — set the deployed Cloudflare Worker URL and mint/revoke share
 * codes. The Worker URL is only needed when using this feature; sharing also
 * requires Gemini embeddings + Qdrant cloud (validated when you create a code).
 */
const ShareSettings: React.FC = () => {
  const { config, updateConfig } = useSettingsStore();
  const share = config.share ?? { workerUrl: '' };
  const vscode = VSCodeAPI();

  const createShare = () => vscode.postMessage({ type: MESSAGE_TYPES.SHARE_TO_CHROME });
  const manageShares = () => vscode.postMessage({ type: MESSAGE_TYPES.MANAGE_SHARES });

  return (
    <div className='settings-section'>
      <div className='section-header'>
        <h3>Share to Chrome</h3>
      </div>
      <div className='settings-form'>
        <div className='form-group'>
          <label htmlFor='share-worker-url'>Worker URL</label>
          <input
            id='share-worker-url'
            type='text'
            value={share.workerUrl ?? ''}
            onChange={(e) => updateConfig('share', 'workerUrl', e.target.value)}
            placeholder='https://workspacegpt-worker.<your-subdomain>.workers.dev'
          />
          <small className='form-text'>
            Your deployed WorkspaceGPT Worker. Required only to create or manage
            share codes. Sharing needs Gemini embeddings + Qdrant cloud.
          </small>
        </div>

        <div className='form-group' style={{ display: 'flex', gap: 8 }}>
          <button className='primary-button' onClick={createShare}>
            Create share code
          </button>
          <button className='secondary-button' onClick={manageShares}>
            Manage shares
          </button>
        </div>
      </div>
    </div>
  );
};

export default ShareSettings;
