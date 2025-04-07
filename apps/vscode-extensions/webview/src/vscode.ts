import { MESSAGE_TYPES } from "./constants";

declare global {
  interface Window {
    acquireVsCodeApi: () => {
      postMessage: (message: any) => void;
      getState: () => any;
      setState: (state: any) => void;
      clearState: () => void; // Add this
    };
  }
}

let vscodeApi: any;

export function VSCodeAPI() {
  if (!vscodeApi) {
    vscodeApi = window.acquireVsCodeApi();
    // vscodeApi.setState({});

  }
  return vscodeApi;
}

// Function to clear stored webview state
export function clearVSCodeState() {
  const vscode = VSCodeAPI();
  vscode.setState({});
  vscode.postMessage({
    type: MESSAGE_TYPES.CLEAR_GLOBAL_STATE,
  });
}
