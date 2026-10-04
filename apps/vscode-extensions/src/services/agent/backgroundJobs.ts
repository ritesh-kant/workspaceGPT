import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { resolveCommandPath } from './commandTools';

/**
 * Long-running commands (a data download, a backfill, a full build) cannot fit
 * run_command's 300s ceiling, and killing them at it throws the work away. A
 * background job is started the same gated way as any command, then outlives
 * the call: the model polls it with `check_command`, which never needs a card
 * because it only reads what the user already approved.
 *
 * The full output goes to a log file the user can open; memory keeps only a
 * tail. Jobs are killed with the host so none is orphaned.
 */

const MAX_RUNNING_JOBS = 4;
const TAIL_CHARS = 20_000;
const RESULT_TAIL_CHARS = 6_000;
const MAX_WAIT_SEC = 90;

interface Job {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  running: boolean;
  tail: string;
  logFile: string;
  pid?: number;
}

const jobs = new Map<string, Job>();

const killGroup = (job: Job) => {
  if (!job.pid) return;
  try {
    process.kill(process.platform === 'win32' ? job.pid : -job.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
};

process.once('exit', () => jobs.forEach((j) => j.running && killGroup(j)));

export async function startBackgroundCommand(command: string, cwd: string): Promise<{ jobId: string; logFile: string }> {
  if ([...jobs.values()].filter((j) => j.running).length >= MAX_RUNNING_JOBS) {
    throw new Error(`${MAX_RUNNING_JOBS} background jobs are already running — wait for one to finish or stop it with check_command {stop: true}.`);
  }
  const id = randomUUID().slice(0, 8);
  const dir = path.join(os.tmpdir(), 'workspacegpt-jobs');
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, `${id}.log`);
  const isWin = process.platform === 'win32';
  const [file, args] = isWin ? ['cmd.exe', ['/d', '/s', '/c', command]] : ['/bin/bash', ['-lc', command]];
  const commandPath = await resolveCommandPath();
  const job: Job = { id, command, cwd, startedAt: Date.now(), endedAt: null, exitCode: null, running: true, tail: '', logFile };
  const child = spawn(file, args as string[], {
    cwd,
    env: { ...process.env, ...(commandPath ? { PATH: commandPath } : {}), CI: '1', FORCE_COLOR: '0', PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWin,
  });
  job.pid = child.pid;
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  const onData = (chunk: Buffer | string) => {
    const text = chunk.toString();
    log.write(text);
    job.tail = (job.tail + text).slice(-TAIL_CHARS);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const finish = (code: number | null) => {
    if (!job.running) return;
    job.running = false;
    job.exitCode = code;
    job.endedAt = Date.now();
    log.end();
  };
  child.on('error', (err) => {
    onData(`\n${err.message}\n`);
    finish(null);
  });
  child.on('close', (code) => finish(typeof code === 'number' ? code : null));
  jobs.set(id, job);
  return { jobId: id, logFile };
}

export async function checkBackgroundCommand(args: { id?: string; waitSec?: number; stop?: boolean }) {
  const job = args?.id ? jobs.get(String(args.id)) : undefined;
  if (!job) {
    const known = [...jobs.keys()].join(', ') || 'none';
    throw new Error(`No background job "${args?.id ?? ''}" in this session (known: ${known}).`);
  }
  if (args.stop && job.running) {
    killGroup(job);
    await new Promise((r) => setTimeout(r, 500));
  } else if (job.running && args.waitSec) {
    const until = Date.now() + Math.min(Math.max(args.waitSec, 1), MAX_WAIT_SEC) * 1000;
    while (job.running && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
  }
  const elapsedMs = (job.endedAt ?? Date.now()) - job.startedAt;
  return {
    id: job.id,
    command: job.command,
    running: job.running,
    exitCode: job.exitCode,
    durationMs: elapsedMs,
    logFile: job.logFile,
    output: job.tail.slice(-RESULT_TAIL_CHARS),
    ...(job.running ? { hint: 'Still running. Call check_command again with waitSec (up to 90) instead of polling in a loop; tell the user where the log is if they want to watch it.' } : {}),
  };
}
