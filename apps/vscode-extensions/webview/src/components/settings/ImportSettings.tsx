import React, { useEffect, useState } from "react";
import { VSCodeAPI } from "../../vscode";
import { MESSAGE_TYPES } from "../../constants";
import SectionShell from "./SectionShell";

type Source = "claude-code" | "cursor";

interface Detection {
  source: Source;
  available: boolean;
  found: number;
  imported: number;
  error?: string;
}

interface Result {
  source: Source;
  imported: number;
  skipped: number;
  failed: number;
  error?: string;
}

interface LogEntry {
  source: Source;
  at: number;
  imported: number;
  failed: number;
  error?: string;
}

const LABELS: Record<Source, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
};

function plural(n: number): string {
  return `${n} chat${n === 1 ? "" : "s"}`;
}

/**
 * Desktop only: bring chats from other coding tools into history. Read and
 * written on this machine; the host skips anything already imported, so
 * running it again only adds what is new.
 */
const ImportSettings: React.FC = () => {
  const [sources, setSources] = useState<Detection[] | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState<{
    source: Source;
    done: number;
    total: number;
  } | null>(null);
  const [results, setResults] = useState<Partial<Record<Source, Result>>>({});

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const m = event.data;
      if (m?.type === MESSAGE_TYPES.IMPORT_DETECT_RESULT) {
        setSources(m.sources);
        setLog(m.log ?? []);
      } else if (m?.type === MESSAGE_TYPES.IMPORT_PROGRESS)
        setRunning({ source: m.source, done: m.done, total: m.total });
      else if (m?.type === MESSAGE_TYPES.IMPORT_RESULT) {
        setRunning(null);
        setResults((prev) => ({ ...prev, [m.result.source]: m.result }));
        VSCodeAPI().postMessage({ type: MESSAGE_TYPES.IMPORT_DETECT });
      }
    };
    window.addEventListener("message", onMessage);
    VSCodeAPI().postMessage({ type: MESSAGE_TYPES.IMPORT_DETECT });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const start = (source: Source) => {
    setRunning({ source, done: 0, total: 0 });
    VSCodeAPI().postMessage({ type: MESSAGE_TYPES.IMPORT_RUN, source });
  };

  const detail = (d: Detection, r?: Result): string => {
    if (r?.error) return r.error;
    if (r) {
      const parts = [`Imported ${plural(r.imported)}`];
      if (r.failed) parts.push(`${r.failed} could not be read`);
      return parts.join(" · ");
    }
    if (d.error) return d.error;
    if (!d.available) return "Not found on this machine";
    const pending = d.found - d.imported;
    return pending > 0
      ? `${plural(pending)} to import${d.imported ? ` · ${d.imported} already imported` : ""}`
      : `All ${plural(d.found)} imported`;
  };

  return (
    <>
      <SectionShell storageKey="import" title="Import" defaultOpen>
        <div className="settings-form">
          {sources === null && (
            <span className="import-detail">
              Looking for chats on this machine…
            </span>
          )}
          {sources?.map((d) => {
            const busy = running?.source === d.source;
            const nothingNew =
              d.available && !d.error && d.found - d.imported === 0;
            return (
              <div className="import-row" key={d.source}>
                <div className="import-text">
                  <span className="import-name">{LABELS[d.source]}</span>
                  <span className="import-detail">
                    {busy
                      ? `Importing… ${running.done} of ${running.total}`
                      : detail(d, results[d.source])}
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    !d.available || !!d.error || nothingNew || !!running
                  }
                  onClick={() => start(d.source)}
                >
                  {busy ? "Importing…" : "Import"}
                </button>
              </div>
            );
          })}
        </div>
      </SectionShell>
      <ImportHistory log={log} />
    </>
  );
};

/** Past runs, newest first. */
const ImportHistory: React.FC<{ log: LogEntry[] }> = ({ log }) => {
  if (!log.length) return null;
  return (
    <SectionShell
      storageKey="import-history"
      title="Import history"
      defaultOpen
    >
      <div className="settings-form">
        {log.map((e) => (
          <div className="import-row" key={`${e.source}-${e.at}`}>
            <div className="import-text">
              <span className="import-name">
                Imported from {LABELS[e.source]}
              </span>
              <span className="import-detail">
                {new Date(e.at).toLocaleString([], {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
                {e.error
                  ? ` · ${e.error}`
                  : ` · ${plural(e.imported)} imported${e.failed ? ` · ${e.failed} failed` : ""}`}
              </span>
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  );
};

export default ImportSettings;
