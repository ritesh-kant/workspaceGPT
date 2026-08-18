// src/headless/vscode-stub.mjs
import * as fs from "fs";
var window = {
  createOutputChannel: () => ({
    append() {
    },
    appendLine() {
    },
    show() {
    },
    clear() {
    },
    dispose() {
    }
  })
};
if (!fs.existsSync)
  throw new Error("vscode-stub: fs unavailable");

// ../../apps/vscode-extensions/src/services/agent/commandTools.ts
import { execFile } from "child_process";
import { appendFile, mkdir } from "fs/promises";
import * as path from "path";

// ../../apps/vscode-extensions/src/services/codebase/codebaseTools.ts
var MAX_FILE_SIZE_BYTES = 512 * 1024;
var MAX_READ_BYTES = 20 * 1024;
var WorkspaceRootRequiredError = class extends Error {
  constructor() {
    super("No workspace folder is open \u2014 codebase tools are unavailable.");
  }
};

// ../../apps/vscode-extensions/src/services/agent/commandTools.ts
var MAX_OUTPUT_CHARS = 2e4;
var DEFAULT_TIMEOUT_SEC = 60;
var MAX_TIMEOUT_SEC = 300;
var COMMAND_DENYLIST = [
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME)/i, reason: "recursive delete of home or filesystem root" },
  { pattern: /\bsudo\b/, reason: "privilege escalation" },
  { pattern: /\bmkfs\b|\bdiskutil\s+erase/i, reason: "disk formatting" },
  { pattern: /\bgit\s+push\b.*(--force|-f\b)/, reason: "force push" },
  { pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, reason: "destructive git on the user repo \u2014 use checkpoints instead" },
  { pattern: /(curl|wget)\b[^|;&]*\|\s*(ba|z|fi)?sh\b/, reason: "piping a download into a shell" },
  { pattern: /\b(shutdown|reboot|halt)\b/, reason: "system power control" },
  { pattern: /\bchmod\s+(-[a-z]+\s+)*777\b/i, reason: "world-writable permissions" },
  { pattern: /\b(launchctl|systemctl|crontab)\b/, reason: "system service / scheduler modification" },
  { pattern: />\s*\/dev\/(sd|disk|nvme)/i, reason: "raw device write" }
];
function assertCommandAllowed(command) {
  for (const { pattern, reason } of COMMAND_DENYLIST) {
    if (pattern.test(command)) {
      throw new Error(
        `Command blocked (${reason}). This class of command is never run by the agent \u2014 ask the user to run it themselves if it is genuinely needed.`
      );
    }
  }
}
function resolveCommandCwd(roots, cwdArg) {
  if (!roots.length)
    throw new WorkspaceRootRequiredError();
  const rootFsPath = roots[0].uri.fsPath;
  if (!cwdArg)
    return { cwd: rootFsPath, displayCwd: "." };
  const abs = path.resolve(rootFsPath, cwdArg.replace(/^\.?\//, ""));
  if (abs !== rootFsPath && !abs.startsWith(rootFsPath + path.sep)) {
    throw new Error("cwd resolves outside the workspace root.");
  }
  return { cwd: abs, displayCwd: path.relative(rootFsPath, abs) || "." };
}
function executeCommand(command, cwd, timeoutSec) {
  const timeout = Math.min(Math.max(timeoutSec ?? DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC) * 1e3;
  const started = Date.now();
  const isWin = process.platform === "win32";
  const [file, args] = isWin ? ["cmd.exe", ["/d", "/s", "/c", command]] : ["/bin/bash", ["-lc", command]];
  return new Promise((resolve2) => {
    execFile(
      file,
      args,
      { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: "1" } },
      (err, stdout, stderr) => {
        const combined = [stdout, stderr].filter(Boolean).join(stderr ? "\n--- stderr ---\n" : "");
        const truncated = combined.length > MAX_OUTPUT_CHARS;
        resolve2({
          exitCode: err ? typeof err.code === "number" ? err.code : null : 0,
          output: truncated ? combined.slice(0, MAX_OUTPUT_CHARS) + "\n\u2026 (output truncated)" : combined,
          durationMs: Date.now() - started,
          truncated,
          timedOut: !!err?.killed
        });
      }
    );
  });
}
var channel = null;
function agentOutputChannel() {
  if (!channel)
    channel = window.createOutputChannel("WorkspaceGPT Agent");
  return channel;
}
async function recordAgentAudit(globalStorageFsPath, entry) {
  const file = path.join(globalStorageFsPath, "agent-actions.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}
export {
  agentOutputChannel,
  assertCommandAllowed,
  executeCommand,
  recordAgentAudit,
  resolveCommandCwd
};
