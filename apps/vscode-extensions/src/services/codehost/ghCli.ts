import { execFile, spawn, ChildProcess } from 'child_process';

/**
 * The GitHub CLI as a sign-in for hosts we have no OAuth App on (GitHub
 * Enterprise). `gh`'s own OAuth app is available on every Enterprise host, so
 * `gh auth login --web` gives a one-click browser authorization — SSO included —
 * with no personal access token to create. We never keep our own copy of the
 * token: each use asks `gh auth token`, so `gh` stays the source of truth.
 */

/** A GUI-launched app often lacks Homebrew's bin on PATH; add the usual places gh lives. */
export function ghEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (process.platform !== 'win32') env.PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].filter(Boolean).join(':');
  return env;
}

function runGh(args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('gh', args, { env: ghEnv({ GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }), timeout, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
}

export async function ghInstalled(): Promise<boolean> {
  return runGh(['--version']).then(() => true, () => false);
}

/** The token `gh` holds for `host` (for `user`, when several accounts are signed in), or undefined when not signed in there. */
export async function ghToken(host: string, user?: string): Promise<string | undefined> {
  const out = await runGh(['auth', 'token', '--hostname', host, ...(user ? ['--user', user] : [])]).catch(() => '');
  return out.trim() || undefined;
}

/** Every account `gh` is signed in to on `host`. Empty when gh is missing or too old for `--json`, which keeps single-account behaviour. */
export async function ghAccounts(host: string): Promise<Array<{ login: string; active: boolean }>> {
  // `gh auth status` exits non-zero when any one account has a bad token but still prints the rest, so read stdout either way.
  const out = await new Promise<string>((resolve) =>
    execFile('gh', ['auth', 'status', '--hostname', host, '--json', 'hosts'], { env: ghEnv({ GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }), timeout: 10_000, windowsHide: true }, (_e, stdout) => resolve(stdout || '')));
  try {
    const list: any[] = JSON.parse(out).hosts?.[host] ?? [];
    return list.filter((a) => a?.state === 'success' && a.login).map((a) => ({ login: String(a.login), active: !!a.active }));
  } catch {
    return [];
  }
}

export interface GhLogin {
  promise: Promise<void>;
  cancel: () => void;
}

/**
 * `gh auth login --web` for `host`. `onCode` gets the one-time code and the
 * page to enter it at while the user authorizes in the browser; the promise
 * settles when gh exits.
 */
export function startGhLogin(host: string, onCode: (info: { code: string; url: string }) => void, openUrl: (url: string) => void): GhLogin {
  // Where we can, stop gh opening the browser itself so the page is opened exactly once, by us.
  const ownBrowser = process.platform !== 'win32';
  const child: ChildProcess = spawn('gh', ['auth', 'login', '--hostname', host, '--web', '--git-protocol', 'https', '--skip-ssh-key'], {
    env: ghEnv({ GH_PROMPT_DISABLED: '1', NO_COLOR: '1', ...(ownBrowser ? { GH_BROWSER: 'true' } : {}) }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let announced = false;
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    if (announced) return;
    const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(output)?.[1];
    if (!code) return;
    announced = true;
    const url = /(https?:\/\/\S+\/login\/device)/.exec(output)?.[1] ?? `https://${host}/login/device`;
    onCode({ code, url });
    if (ownBrowser) openUrl(url);
    child.stdin?.write('\n'); // harmless where gh asks "Press Enter to open the browser"
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for GitHub authorization. Try again.'));
    }, 5 * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error("The GitHub CLI isn't installed. Install it from https://cli.github.com, then try again.") : e);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      if (signal) return reject(new Error('Sign-in cancelled.'));
      const detail = output.split('\n').map((l) => l.trim()).filter((l) => l && !/one-time code|login\/device/i.test(l)).slice(-2).join(' ');
      reject(new Error(`GitHub CLI sign-in failed${detail ? `: ${detail}` : '.'}`));
    });
  });
  return { promise, cancel: () => child.kill() };
}
