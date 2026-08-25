import React, { useEffect, useRef, useState } from 'react';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES } from '../../constants';
import SectionShell from './SectionShell';

/** How long to wait for the host's setup result before offering a retry. */
const SETUP_TIMEOUT_MS = 30000;

const McpSettings: React.FC = () => {
  const vscode = VSCodeAPI();
  const [isInstalled, setIsInstalled] = useState<boolean | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [messageType, setMessageType] = useState<'success' | 'error'>('success');
  const setupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSetupTimer = () => {
    if (setupTimer.current) {
      clearTimeout(setupTimer.current);
      setupTimer.current = null;
    }
  };

  useEffect(() => {
    // Ask extension for current MCP status on mount
    vscode.postMessage({ type: MESSAGE_TYPES.MCP_STATUS });

    const handleMessage = (event: MessageEvent) => {
      const message = event.data;

      if (message.type === MESSAGE_TYPES.MCP_STATUS) {
        clearSetupTimer();
        setIsInstalled(message.isInstalled);
        setIsInstalling(false);
        if (message.message) {
          setMessageType(message.isInstalled ? 'success' : 'error');
          setStatusMessage(message.message);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      clearSetupTimer();
    };
  }, []);

  function handleConnect() {
    setIsInstalling(true);
    setStatusMessage('');
    vscode.postMessage({ type: MESSAGE_TYPES.SETUP_MCP });
    // Without this the button sits on "Connecting…" forever if the host never
    // answers, with no way to tell a slow setup from a failed one.
    clearSetupTimer();
    setupTimer.current = setTimeout(() => {
      setIsInstalling(false);
      setMessageType('error');
      setStatusMessage('Setup timed out — check the WorkspaceGPT output log and try again.');
    }, SETUP_TIMEOUT_MS);
  }

  const summary =
    isInstalled === null
      ? 'Checking…'
      : isInstalled
        ? '✅ Connected'
        : 'Not connected';

  return (
    <SectionShell storageKey='mcp' title='MCP Server' summary={summary}>
      <div className='settings-form'>
        <div className='form-group'>
          <small className='form-text'>
            Connect WorkspaceGPT as an MCP server to use your knowledge base
            directly inside Cursor, GitHub Copilot, Claude Desktop, and other AI
            IDEs.
          </small>
        </div>

        <div className='form-group'>
          <div className='mcp-status-row'>
            <span
              className={`mcp-status-dot${
                isInstalled === null ? '' : isInstalled ? ' mcp-status-dot--on' : ' mcp-status-dot--off'
              }`}
            />
            <span className='mcp-status-text'>
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
            <div className={`status-message ${messageType} mt-8`}>
              {statusMessage}
            </div>
          )}
        </div>
      </div>
    </SectionShell>
  );
};

export default McpSettings;
