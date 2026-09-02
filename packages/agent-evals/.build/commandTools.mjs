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
import { spawn } from "child_process";
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
var VERIFY_TIMEOUT_SEC = 180;
var MAX_TIMEOUT_SEC = 600;
var VERIFY_COMMAND_RE = /\b(test|tests|jest|vitest|pytest|mocha|build|compile|tsc|typecheck|type-check|lint|eslint|cargo|go)\b/i;
function defaultTimeoutSec(command) {
  return VERIFY_COMMAND_RE.test(command) ? VERIFY_TIMEOUT_SEC : DEFAULT_TIMEOUT_SEC;
}
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
var AUTONOMOUS_BINARIES = /* @__PURE__ */ new Set(["pnpm", "npm", "yarn", "bun", "turbo", "npx", "go", "cargo", "make", "python", "python3"]);
var AUTONOMOUS_STANDALONE = /* @__PURE__ */ new Set(["tsc", "jest", "vitest", "eslint", "prettier", "pytest"]);
var AUTONOMOUS_READONLY = /* @__PURE__ */ new Set(["wc", "ls", "cat", "head", "tail", "file", "stat", "basename", "dirname"]);
var AUTONOMOUS_VERBS = /* @__PURE__ */ new Set([
  "test",
  "tests",
  "lint",
  "typecheck",
  "type-check",
  "check",
  "vet",
  "build",
  "compile",
  ...AUTONOMOUS_STANDALONE
]);
var HARMLESS_SUFFIX_RE = /(\s+2>&1)?(\s*\|\s*(tail|head)(\s+-n\s*\d+|\s+-\d+)?)?\s*$/;
function isAutonomousSafeCommand(command) {
  const core = command.trim().replace(HARMLESS_SUFFIX_RE, "");
  if (/[;&|><`$\n\r]/.test(core))
    return false;
  const tokens = core.split(/\s+/);
  const binary = tokens[0];
  if (AUTONOMOUS_READONLY.has(binary))
    return true;
  if (AUTONOMOUS_STANDALONE.has(binary))
    return true;
  if (!AUTONOMOUS_BINARIES.has(binary))
    return false;
  return tokens.slice(1).some((t) => AUTONOMOUS_VERBS.has(t));
}
function describeAutonomousRefusal(command) {
  const core = command.trim().replace(HARMLESS_SUFFIX_RE, "");
  if (/[;&|><`$\n\r]/.test(core)) {
    return `Command refused: autonomous runs never execute shell chaining, pipes, redirects or substitutions (found in "${command}"). You do not need them \u2014 stdout and stderr are captured together and truncated for you. Re-run the SAME command as a single plain invocation (e.g. "npx jest --no-coverage path/to/test.ts").`;
  }
  return `Command refused: autonomous runs may only execute verification commands (test / lint / type-check / build via pnpm, npm, yarn, npx, tsc, jest, vitest, pytest, go, cargo, make) \u2014 "${command}" is outside that allowlist. Do not retry it. Use run_checks with the file path instead \u2014 it derives an allowed command in the right directory \u2014 or note the command in your final report for the user to run.`;
}
function resolveCommandCwd(roots, cwdArg) {
  if (!roots.length)
    throw new WorkspaceRootRequiredError();
  let root = roots[0];
  let rel = (cwdArg ?? "").replace(/^\.?\//, "");
  if (rel && roots.length > 1) {
    for (const r of roots) {
      if (rel === r.name || rel.startsWith(`${r.name}/`)) {
        root = r;
        rel = rel.slice(r.name.length).replace(/^\//, "");
        break;
      }
    }
  }
  const rootFsPath = root.uri.fsPath;
  if (!rel)
    return { cwd: rootFsPath, displayCwd: roots.length > 1 ? root.name : "." };
  const abs = path.resolve(rootFsPath, rel);
  if (abs !== rootFsPath && !abs.startsWith(rootFsPath + path.sep)) {
    throw new Error("cwd resolves outside the workspace root.");
  }
  const display = path.relative(rootFsPath, abs) || ".";
  return { cwd: abs, displayCwd: roots.length > 1 ? `${root.name}/${display}` : display };
}
function executeCommand(command, cwd, timeoutSec, onOutput) {
  const timeout = Math.min(Math.max(timeoutSec ?? defaultTimeoutSec(command), 1), MAX_TIMEOUT_SEC) * 1e3;
  const started = Date.now();
  const isWin = process.platform === "win32";
  const [file, args] = isWin ? ["cmd.exe", ["/d", "/s", "/c", command]] : ["/bin/bash", ["-lc", command]];
  return new Promise((resolve2) => {
    let combined = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      const truncated = combined.length > MAX_OUTPUT_CHARS;
      resolve2({
        exitCode,
        output: truncated ? combined.slice(0, MAX_OUTPUT_CHARS) + "\n\u2026 (output truncated)" : combined,
        durationMs: Date.now() - started,
        truncated,
        timedOut
      });
    };
    let child;
    try {
      child = spawn(file, args, { cwd, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      combined = e instanceof Error ? e.message : String(e);
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      combined += `
\u2026 killed after ${Math.round(timeout / 1e3)}s timeout`;
      child.kill("SIGKILL");
    }, timeout);
    let lastStream = null;
    const append = (stream) => (chunk) => {
      if (combined.length >= MAX_OUTPUT_CHARS + 2e3)
        return;
      if (stream === "stderr" && lastStream === "stdout")
        combined += "\n--- stderr ---\n";
      lastStream = stream;
      combined += chunk.toString();
      onOutput?.(combined);
    };
    child.stdout?.on("data", append("stdout"));
    child.stderr?.on("data", append("stderr"));
    child.on("error", (err) => {
      combined += (combined ? "\n" : "") + err.message;
      finish(null);
    });
    child.on("close", (code) => finish(typeof code === "number" ? code : null));
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
  defaultTimeoutSec,
  describeAutonomousRefusal,
  executeCommand,
  isAutonomousSafeCommand,
  recordAgentAudit,
  resolveCommandCwd
};
