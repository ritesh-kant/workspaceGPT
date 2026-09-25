// MV3 service worker. Opens the side panel when the toolbar icon is clicked.
import { installBridge } from './lib/browserControl';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('Failed to set side panel behavior:', err));

// Lets WorkspaceGPT Desktop's agent read tabs in this profile, once turned on in Settings.
installBridge();
