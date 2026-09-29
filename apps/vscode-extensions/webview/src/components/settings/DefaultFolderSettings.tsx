import React, { useEffect, useState } from "react";
import { VSCodeAPI } from "../../vscode";
import { MESSAGE_TYPES } from "../../constants";
import {
  folderName,
  sameFolder,
  useWorkspaceFolders,
} from "../../hooks/useWorkspaceFolders";
import {
  ChipMenu,
  FolderIcon,
  looksLikePath,
  type MenuRow,
} from "../WorkspaceControls";
import SectionShell from "./SectionShell";
import StatusDot from "./StatusDot";

/**
 * Where ticket work belongs, whichever Knowledge source the ticket came from.
 * Starting a ticket in any other folder asks whether to switch here first
 * (FolderSwitchDialog.tsx). The picker offers the folders this app has opened
 * or a typed path; the host checks the path is a folder.
 */
const DefaultFolderSettings: React.FC = () => {
  const { current, recent, home, defaultFolder } = useWorkspaceFolders();
  const [error, setError] = useState<string | null>(null);
  const [closeSignal, setCloseSignal] = useState(0);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const m = event.data;
      if (m?.type !== MESSAGE_TYPES.DEFAULT_FOLDER_RESULT) return;
      if (m.ok) setCloseSignal((n) => n + 1);
      else setError(m.error || "That did not work.");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const tilde = (p: string) =>
    home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  const choose = (path?: string) => {
    setError(null);
    VSCodeAPI().postMessage({ type: MESSAGE_TYPES.SET_DEFAULT_FOLDER, path });
  };

  const rows = (search: string): MenuRow[] => {
    const q = search.trim().toLowerCase();
    const folders = [
      ...new Set([defaultFolder, current, ...recent].filter(Boolean)),
    ];
    const list: MenuRow[] = folders
      .filter(
        (p) =>
          !q ||
          p.toLowerCase().includes(q) ||
          tilde(p).toLowerCase().includes(q),
      )
      .map((p) => ({
        key: p,
        label: folderName(p),
        subtitle: sameFolder(p, current) ? `${tilde(p)} · open now` : tilde(p),
        selected: sameFolder(p, defaultFolder),
        onPick: () => choose(p),
      }));
    if (looksLikePath(search)) {
      list.unshift({
        key: "\0typed",
        label: `Use “${search.trim()}”`,
        onPick: () => choose(search.trim()),
      });
    }
    return list;
  };

  const summary = defaultFolder ? (
    <>
      <StatusDot tone="ok" />
      {folderName(defaultFolder)}
    </>
  ) : (
    "Not set"
  );

  return (
    <SectionShell
      storageKey="defaultFolder"
      title="Default folder"
      summary={summary}
      defaultOpen={!defaultFolder}
    >
      <div className="settings-form">
        <div className="form-group">
          <small className="form-text">
            The folder you start work in from Azure DevOps, Jira or Confluence.
            If a different folder is open when you start a ticket, you’re asked
            which one to use.
          </small>
        </div>
        <div className="form-group">
          <div className="default-folder-row">
            <ChipMenu
              icon={<FolderIcon />}
              label={
                defaultFolder ? folderName(defaultFolder) : "Choose a folder"
              }
              title={
                defaultFolder
                  ? tilde(defaultFolder)
                  : "Choose the default folder"
              }
              searchPlaceholder="Search folders, or type a path"
              rows={rows}
              emptyLabel="No folders yet. Type a path."
              onOpen={() => {
                setError(null);
                VSCodeAPI().postMessage({
                  type: MESSAGE_TYPES.GET_RECENT_FOLDERS,
                });
              }}
              closeSignal={closeSignal}
            />
            {defaultFolder && (
              <>
                <span className="default-folder-path" title={defaultFolder}>
                  {tilde(defaultFolder)}
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => choose(undefined)}
                >
                  Clear
                </button>
              </>
            )}
          </div>
        </div>
        {error && (
          <div className="workspace-controls-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </SectionShell>
  );
};

export default DefaultFolderSettings;
