declare global {
  interface Window {
    acquireVsCodeApi: () => {
      postMessage: (message: any) => void;
      getState: () => any;
      setState: (state: any) => void;
    };
  }
}

let vscodeApi: any;

export function VSCodeAPI() {
    if (!vscodeApi) {
        vscodeApi = window.acquireVsCodeApi();
    }
    return vscodeApi;
}