import React from 'react';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES } from '../../constants';
import SectionShell from './SectionShell';

/**
 * Share to Chrome — generate a share code that carries the current credentials
 * to the Chrome extension. Requires Gemini embeddings + Qdrant cloud (validated
 * when you create the code). The code contains real API keys in plain form, so
 * it should only be shared with people you trust.
 */
const ShareSettings: React.FC = () => {
  const vscode = VSCodeAPI();
  const createShare = () => vscode.postMessage({ type: MESSAGE_TYPES.SHARE_TO_CHROME });

  return (
    <SectionShell
      storageKey='share'
      title='Share to Chrome'
      summary='Send your setup to the Chrome extension'
    >
      <div className='settings-form'>
        <div className='form-group'>
          <small className='form-text'>
            Creates a share code (copied to your clipboard) that you paste into
            the WorkspaceGPT Chrome extension. It carries your Qdrant, Gemini, and
            chat-model keys — only share it with people you trust. Requires Gemini
            embeddings + Qdrant cloud.
          </small>
        </div>
        <div className='form-group'>
          <button className='primary-button' onClick={createShare}>
            Create share code
          </button>
        </div>
        <div className='form-group'>
          <small className='form-text'>
            Don't have it yet?{' '}
            <a
              href='https://chromewebstore.google.com/detail/workspacegpt/gagogpeepmgaljpabdlpbcknjnbcaole'
              target='_blank'
              rel='noopener noreferrer'
            >
              Get the WorkspaceGPT Chrome extension
            </a>
            .
          </small>
        </div>
      </div>
    </SectionShell>
  );
};

export default ShareSettings;
