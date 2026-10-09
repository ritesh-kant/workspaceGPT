import React, { useState } from 'react';
import { useSettingsStore } from '../store';
import { prepareToConnect } from './settings/knowledgeSources';

interface MyWorkTeaserProps {
  /** Opens Settings on a source id, like the knowledge line does. */
  onOpen: (page: string) => void;
}

const DISMISSED_KEY = 'workspacegpt.myWorkTeaserDismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * What "Your work" would be, shown while no ticket source is connected.
 *
 * Without it the panel is simply absent, so the feature can't be discovered
 * until after Azure DevOps or Jira is connected. Dismissible, and stays
 * dismissed; connecting a source replaces it with the real panel anyway.
 */
const MyWorkTeaser: React.FC<MyWorkTeaserProps> = ({ onOpen }) => {
  const { config } = useSettingsStore();
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);

  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      // Non-persistent storage: dismissed for this session only.
    }
  };
  const connect = (id: 'ado' | 'jira') => {
    prepareToConnect(id, config);
    onOpen(id);
  };

  return (
    <div className='my-work-panel my-work-teaser'>
      <div className='my-work-header'>
        <h2 className='my-work-title'>Your work</h2>
        <button type='button' className='my-work-refresh' onClick={dismiss} data-tooltip='Dismiss' aria-label='Dismiss Your work'>
          ✕
        </button>
      </div>
      <div className='my-work-teaser-body'>
        <div className='my-work-teaser-text'>
          See the tickets assigned to you here and start any of them in one click.
        </div>
        <div className='my-work-teaser-actions'>
          <button type='button' className='my-work-teaser-connect' onClick={() => connect('ado')}>
            Connect Azure DevOps
          </button>
          <button type='button' className='my-work-teaser-connect' onClick={() => connect('jira')}>
            Connect Jira
          </button>
        </div>
      </div>
    </div>
  );
};

export default MyWorkTeaser;
