import React, { useEffect, useState } from 'react';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES } from '../../constants';

const McpSettings: React.FC = () => {
  const vscode = VSCodeAPI();
  const [isInstalled, setIsInstalled] = useState<boolean | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [messageType] = useState<'success' | 'error'>('success');

  useEffect(() => {
    // Ask extension for current MCP status on mount
    vscode.postMessage({ type: MESSAGE_TYPES.MCP_STATUS });

    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      if (message.type === MESSAGE_TYPES.MCP_STATUS) {
        setIsInstalled(message.isInstalled);
        setIsInstalling(false);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  function handleConnect() {
    setIsInstalling(true);
    setStatusMessage('');
    vscode.postMessage({ type: MESSAGE_TYPES.SETUP_MCP });
  }

  return (
    <div className='settings-section'>
      <div className='section-header'>
        <h3>MCP Server</h3>
      </div>
      <div className='settings-form'>
        <div className='form-group'>
          <small className='form-text'>
            Connect WorkspaceGPT as an MCP server to use your knowledge base
            directly inside Cursor, GitHub Copilot, Claude Desktop, and other AI
            IDEs.
          </small>
        </div>

        <div className='form-group'>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor:
                  isInstalled === null
                    ? 'var(--vscode-descriptionForeground)'
                    : isInstalled
                      ? 'var(--vscode-testing-iconPassed)'
                      : 'var(--vscode-testing-iconFailed)',
                flexShrink: 0,
                display: 'inline-block',
              }}
            />
            <span style={{ fontSize: '0.8rem' }}>
              {isInstalled === null
                ? 'Checking status…'
                : isInstalled
                  ? 'MCP server is connected'
                  : 'MCP server is not connected'}
            </span>
          </div>
        </div>

        <div className='form-group'>
          <button className='primary-button-full' onClick={handleConnect} disabled={isInstalling}>
            {isInstalling
              ? 'Connecting…'
              : isInstalled
                ? 'Reconfigure MCP Server'
                : 'Connect MCP Server'}
          </button>
          {statusMessage && (
            <div className={`status-message ${messageType}`} style={{ marginTop: '8px' }}>
              {statusMessage}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default McpSettings;
