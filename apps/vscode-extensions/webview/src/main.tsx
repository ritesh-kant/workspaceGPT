import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/tokens.css';
import App from './App';
import { VSCodeAPI } from './vscode';
import { registerSettingsMessageListener } from './store/settingsMessages';

VSCodeAPI();
// Owned by the app, not the Settings panel: sync/OAuth completions arrive once
// and must land even while the user is on the chat view.
registerSettingsMessageListener();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
