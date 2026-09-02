import { MESSAGE_TYPES, SIDEBAR_MIN_WIDTH_PX } from "./constants";

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
let collapseWatchStarted = false;

export function VSCodeAPI() {
  if (!vscodeApi) {
    vscodeApi = window.acquireVsCodeApi();
    applySidebarMinWidth();
    startSidebarCollapseWatch(vscodeApi);
  }
  return vscodeApi;
}

/**
 * The layout floor and the collapse threshold have to be the same number, or
 * the view stays open at a width where the content is already clipped. Setting
 * it from the constant keeps SIDEBAR_MIN_WIDTH_PX the single source of truth
 * rather than duplicating the value in static CSS.
 *
 * The floor also goes out as a custom property, because `position: fixed`
 * overlays (the settings panel, chat history) are sized by the viewport rather
 * than by #root — they never inherit its min-width and would keep squeezing
 * past the floor without it. Static CSS reads the variable instead of
 * hardcoding the number.
 */
function applySidebarMinWidth(): void {
  const root = document.getElementById("root");
  if (root) {
    root.style.minWidth = `${SIDEBAR_MIN_WIDTH_PX}px`;
  }
  document.documentElement.style.setProperty(
    "--wgpt-sidebar-min-width",
    `${SIDEBAR_MIN_WIDTH_PX}px`
  );
}

function viewportWidth(): number {
  const candidates = [
    window.visualViewport?.width,
    window.innerWidth,
    document.documentElement?.clientWidth,
    document.body?.clientWidth,
  ].filter((value): value is number => typeof value === "number" && value > 0);
  return candidates.length ? Math.min(...candidates) : 0;
}

/**
 * Which workbench area to ask the host to close.
 *
 * A webview is an iframe, and an iframe's `screenX` reports the position of the
 * whole VS Code window rather than the view's offset inside it — so left vs
 * right cannot be told apart from in here. Guessing wrong is worse than not
 * guessing: closing the auxiliary bar when the view is docked left leaves the
 * squeezed layout on screen. The view is contributed to the activity bar, so
 * default to the primary sidebar.
 */
function guessDock(): "left" | "right" | "bottom" {
  return "left";
}

/**
 * Only hide when the user drags the sash smaller. Closing whenever the
 * viewport is below the min also fires on icon-click (the restored width is
 * often still narrow, or the first layout frames are), which made the view
 * open and immediately close.
 */
function startSidebarCollapseWatch(api: { postMessage: (message: any) => void }): void {
  if (collapseWatchStarted) {
    return;
  }
  collapseWatchStarted = true;

  const startedAt = Date.now();
  let lastWidth = 0;
  let collapsePosted = false;
  let wasHidden = false;
  // The host is the only place that knows whether the view is really on
  // screen; assume visible until told otherwise, since the webview is only
  // created while the view is being revealed.
  let hostVisible = true;
  let becameVisibleAt = startedAt;

  const tick = () => {
    // While another view owns the sidebar this webview is retained and still
    // gets laid out, so it keeps seeing width changes the user is making to
    // somebody else's view. Freeze the baseline instead of reading them as a
    // drag of ours.
    if (!hostVisible) {
      wasHidden = true;
      return;
    }

    const width = viewportWidth();
    if (width < 8) {
      wasHidden = true;
      return;
    }

    // Icon click reuses the same webview. The first frames after reveal are
    // not a sash drag — do not treat them as "squeezed too far".
    if (wasHidden || Date.now() - startedAt < 1500 || Date.now() - becameVisibleAt < 1500) {
      wasHidden = false;
      lastWidth = width;
      collapsePosted = false;
      return;
    }

    const shrinking = lastWidth > 0 && width < lastWidth - 4;
    lastWidth = width;

    if (width >= SIDEBAR_MIN_WIDTH_PX) {
      collapsePosted = false;
      return;
    }

    if (!shrinking || collapsePosted) {
      return;
    }

    collapsePosted = true;
    api.postMessage({
      type: MESSAGE_TYPES.COLLAPSE_SIDEBAR,
      dock: guessDock(),
    });
  };

  // The 100ms poll alone is not reliable for catching "went hidden": VS Code
  // throttles timers in a backgrounded webview, so a quick close-then-reopen
  // can skip every tick while hidden and leave `wasHidden` false. The first
  // layout frame after reveal can then read as a shrink below the threshold,
  // closing the sidebar that just opened. visibilitychange fires immediately
  // and is not subject to that throttling, so use it as the source of truth.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      wasHidden = true;
    }
  });

  // ...and visibilitychange alone is not enough either: it reports the window,
  // not the sidebar, so switching to another view in the same window never
  // fires it and the poll can keep reading widths that belong to a view the
  // user is resizing instead of ours. The host tells us the truth.
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.type !== MESSAGE_TYPES.VIEW_VISIBILITY) {
      return;
    }
    const visible = event.data.visible !== false;
    if (visible && !hostVisible) {
      // Re-entering at whatever width the sidebar now has: adopt it as the new
      // baseline so the change made while we were away is not a shrink.
      becameVisibleAt = Date.now();
      wasHidden = true;
      lastWidth = 0;
      collapsePosted = false;
    }
    hostVisible = visible;
  });

  window.addEventListener("resize", tick);
  window.visualViewport?.addEventListener("resize", tick);
  window.setInterval(tick, 100);
  tick();
}

export function clearVSCodeState() {
  const vscode = VSCodeAPI();
  vscode.setState({});
  vscode.postMessage({
    type: MESSAGE_TYPES.CLEAR_GLOBAL_STATE,
  });
}
