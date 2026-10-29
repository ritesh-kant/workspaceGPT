#!/usr/bin/env node
/** Regression: node apps/desktop/scripts/webview-state-test.mjs */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import WebSocket from 'ws';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const viewId = 'workspacegpt.chatView';

if (process.argv[2] === '--serve') {
  const [bundle, profile, workspace] = process.argv.slice(3);
  const { startServer, ViewSurface, JsonStore, resolveAppPaths, workspaceStateFile } = createRequire(import.meta.url)(bundle);
  const paths = resolveAppPaths(profile);
  const store = new JsonStore(workspaceStateFile(paths, workspace));
  const surface = new ViewSurface(viewId, () => '', () => []);
  const key = `desktop.webviewState:${viewId}`;
  surface.state = { get: () => store.get(key), set: (value) => { void store.update(key, value); } };
  const server = await startServer({
    port: 0, token: 'test-token', surfaces: new Map([[viewId, surface]]),
    desktopAssetsDir: profile, extraOrigins: [],
  });
  process.send({ origin: server.origin, file: store.file });
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-webview-state-'));
  const children = new Set();
  const sockets = new Set();
  try {
    const bundle = path.join(temp, 'host.cjs');
    await esbuild.build({
      stdin: {
        contents: `export { startServer } from './sidecar/host/server';
          export { ViewSurface } from './sidecar/host/webviewHost';
          export { JsonStore, resolveAppPaths, workspaceStateFile } from './sidecar/host/stores';`,
        resolveDir: root, loader: 'ts',
      },
      bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
    });
    const { ViewSurface } = createRequire(import.meta.url)(bundle);
    const surface = new ViewSurface(viewId, () => '', () => []);
    let ownedState;
    surface.state = { get: () => ownedState, set: (value) => { ownedState = value; } };
    const fakeSocket = () => Object.assign(new EventEmitter(), { readyState: 1, send() {}, close() {} });
    const oldOwner = fakeSocket();
    const newOwner = fakeSocket();
    surface.attach(oldOwner);
    surface.attach(newOwner);
    newOwner.emit('message', JSON.stringify({ t: 'state', d: 'current draft' }));
    oldOwner.emit('message', JSON.stringify({ t: 'state', d: 'stale draft' }));
    assert.equal(ownedState, 'current draft');
    console.log('PASS superseded pages cannot overwrite the current draft');
    async function launch(profile, workspace) {
      const child = fork(script, ['--serve', bundle, profile, workspace], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      children.add(child);
      const [ready] = await once(child, 'message');
      return { ...ready, child };
    }
    async function stop(host) {
      const exited = once(host.child, 'exit');
      host.child.kill('SIGKILL');
      await exited;
      children.delete(host.child);
    }
    async function socket(host) {
      const ws = new WebSocket(`${host.origin.replace('http', 'ws')}/__desktop/ws?t=test-token&view=${viewId}`, { origin: host.origin });
      sockets.add(ws);
      await once(ws, 'open');
      return ws;
    }
    const read = (host, headers = { Authorization: 'Bearer test-token' }) => fetch(`${host.origin}/__desktop/webview-state`, { headers });
    async function persisted(host, value) {
      for (let i = 0; i < 100; i++) {
        try {
          if (JSON.stringify(JSON.parse(fs.readFileSync(host.file, 'utf8'))[`desktop.webviewState:${viewId}`]) === JSON.stringify(value)) return;
        } catch { /* first write has not reached disk */ }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail('state did not reach the workspace profile');
    }

    const profile = path.join(temp, 'profile');
    const workspace = path.join(temp, 'repo-a');
    let host = await launch(profile, workspace);
    assert.equal((await read(host, {})).status, 403);
    assert.equal((await read(host, { Authorization: 'Bearer wrong' })).status, 403);
    assert.equal((await read(host, { Authorization: 'Bearer test-token', Origin: 'https://other.example' })).status, 403);
    const response = await read(host);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { [viewId]: null });
    console.log('PASS bootstrap requires the token, rejects foreign origins, and disables caching');

    const ws = await socket(host);
    const draft = { chat: { state: { inputValue: 'Implement D2C-1234 using the Confluence design', currentSessionId: 'chat-a' } } };
    ws.send(JSON.stringify({ t: 'state', d: draft }));
    await persisted(host, draft);
    const oldPort = new URL(host.origin).port;
    await stop(host);
    host = await launch(profile, workspace);
    assert.notEqual(new URL(host.origin).port, oldPort);
    assert.deepEqual(await (await read(host)).json(), { [viewId]: draft });
    console.log('PASS draft survives a killed host and restores on a new port');

    const current = await socket(host);
    const reset = {};
    current.send(JSON.stringify({ t: 'state', d: reset }));
    await persisted(host, reset);
    await stop(host);
    host = await launch(profile, workspace);
    assert.deepEqual(await (await read(host)).json(), { [viewId]: reset });
    console.log('PASS clearing state persists instead of resurrecting the old draft');
    await stop(host);

    for (const [otherProfile, otherWorkspace] of [[profile, path.join(temp, 'repo-b')], [profile, undefined], [path.join(temp, 'other-profile'), workspace]]) {
      host = await launch(otherProfile, otherWorkspace ?? '');
      assert.deepEqual(await (await read(host)).json(), { [viewId]: null });
      await stop(host);
    }
    console.log('PASS workspaces, no-folder mode, and profiles have independent state');
  } finally {
    for (const ws of sockets) ws.terminate();
    await Promise.all([...children].map(async (child) => {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
